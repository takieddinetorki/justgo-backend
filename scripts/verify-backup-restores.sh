#!/usr/bin/env bash
#
# Proves the newest backup actually restores, by restoring it into a throwaway
# container and comparing it row-for-row against the live database.
#
# WHY COMPARE RATHER THAN PRINT. The first version of this script printed
# counts and reported "0 errors" while every count was empty — it had restored
# into a container that was still running its own initialisation, so Postgres
# re-initialised underneath it and threw the data away. It looked like a pass.
# A backup check that can report success without having restored anything is
# worse than no check, so every number here is asserted against the source.
#
# Touches nothing in the live stack: its own container, its own volume, no
# published ports, removed again whatever happens.
#
#   ./verify-backup-restores.sh
set -uo pipefail

IMAGE="${PG_IMAGE:-supabase/postgres:17.6.1.136}"
LIVE="${PG_CONTAINER:-justgo-supabase-db}"
PROBE="justgo-restore-probe"
VOL="justgo-restore-probe-vol"
DEST="${BACKUP_DIR:-/opt/justgo/backups}"

failures=0
ok()   { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }
die()  { printf '  FAIL  %s\n' "$*"; exit 1; }

cleanup() {
  docker rm -f "$PROBE" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

live_q()  { docker exec "$LIVE"  psql -U postgres -d postgres -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
probe_q() { docker exec "$PROBE" psql -U postgres -d postgres -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }

# Compare one query between the live database and the restored copy.
same() {
  local label="$1" query="$2"
  local a b
  a=$(live_q "$query"); b=$(probe_q "$query")
  if [[ -z "$a" ]]; then bad "$label — the LIVE query returned nothing (query is wrong)"; return; fi
  if [[ "$a" == "$b" ]]; then ok "$label — $a"; else bad "$label — live=$a restored=$b"; fi
}

newest_db=$(find "$DEST" -maxdepth 1 -name 'justgo-*.sql.gz' ! -name '*.globals.sql.gz' \
  -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
[[ -n "$newest_db" ]] || die "no backup found in $DEST"
newest_globals="${newest_db%.sql.gz}.globals.sql.gz"
[[ -f "$newest_globals" ]] || die "no globals dump beside $(basename "$newest_db")"
echo "restoring $(basename "$newest_db")"

cleanup
docker volume create "$VOL" >/dev/null
docker run -d --name "$PROBE" -v "$VOL:/var/lib/postgresql/data" \
  -e POSTGRES_PASSWORD=probe-only "$IMAGE" >/dev/null

# THE SETTLE WAIT, and the reason this script was wrong the first time. The
# image starts Postgres, runs its own migrations against it and restarts it, so
# the first pg_isready is NOT the end of initialisation — restoring there gets
# thrown away by the init that follows. Require it to stay ready, and to stop
# logging, before trusting it.
printf 'waiting for the probe to finish initialising'
ready_streak=0
for _ in $(seq 1 150); do
  if docker exec "$PROBE" pg_isready -U postgres -q 2>/dev/null; then
    ready_streak=$((ready_streak + 1))
  else
    ready_streak=0
  fi
  if (( ready_streak >= 10 )) \
     && docker logs "$PROBE" 2>&1 | tail -3 | grep -q 'database system is ready to accept connections'; then
    echo " ready"
    break
  fi
  printf '.'
  sleep 2
done
(( ready_streak >= 10 )) || die "the probe never settled"

# RESTORE AS THE SUPERUSER, for the same reason the dump is taken as one:
# `auth`, `storage` and `realtime` are owned by supabase_admin, and a restore
# as postgres is refused permission on all three — quietly dropping every
# account, every stored object row and the realtime subscriptions.
gzip -dc "$newest_globals" | docker exec -i "$PROBE" psql -U supabase_admin -d postgres \
  > /tmp/restore-globals.log 2>&1
gzip -dc "$newest_db" | docker exec -i "$PROBE" psql -U supabase_admin -d postgres \
  > /tmp/restore-db.log 2>&1

echo
echo "--- the restored copy must match the live database ---"
# The fiscal series first: it is the one thing that cannot be rebuilt from
# application state, because invoice numbers may not have gaps.
same "documents"            "select count(*) from documents.documents"
same "invoices"             "select count(*) from documents.documents where type = 'invoice'"
same "highest invoice"      "select coalesce(max(number), 'none') from documents.documents where type = 'invoice'"
same "document hashes"      "select coalesce(md5(string_agg(sha256, ',' order by number)), 'none') from documents.documents"
same "accounts"             "select count(*) from identity.accounts"
same "auth users"           "select count(*) from auth.users"
same "role assignments"     "select count(*) from identity.user_roles"
same "permissions"          "select count(*) from identity.permissions"
same "orders"               "select count(*) from orders.orders"
same "part requests"        "select count(*) from requests.part_requests"
same "complaints"           "select count(*) from reclamations.cases"
same "drivers"              "select count(*) from drivers.drivers"
same "posts"                "select count(*) from social.posts"
same "conversations"        "select count(*) from messaging.conversations"
same "suppliers"            "select count(*) from suppliers.suppliers"
same "migrations applied"   "select count(*) from public.schema_migrations"
same "RLS policies"         "select count(*) from pg_policies"
# The index is what stops a redelivered event issuing a second facture for one
# sale. A restore that loses it restores the data and not the guarantee.
same "invoice unique index" "select count(*) from pg_indexes where schemaname = 'documents' and indexname = 'documents_one_invoice_per_subject'"

echo
echo "--- the restored fiscal series must still be gapless ---"
while IFS='|' read -r series year n lo hi; do
  [[ -n "$series" ]] || continue
  if (( hi - lo + 1 == n )); then
    ok "$series-$year: $n documents, seq $lo..$hi contiguous"
  else
    bad "$series-$year: $n documents but seq $lo..$hi — a gap survived the restore"
  fi
done < <(docker exec "$PROBE" psql -U postgres -d postgres -tAc \
  "select series, year, count(*), min(seq), max(seq) from documents.documents
    group by series, year order by series" 2>/dev/null)

echo
errs=$(grep -ci 'ERROR' /tmp/restore-db.log || true)
echo "restore reported ${errs} error line(s); the ones below are expected on this image:"
grep -i 'ERROR' /tmp/restore-db.log | sed 's/^/    /' | head -10 || true
cat <<'NOTE'

  Those are Supabase-managed objects the image already created (the realtime
  publication, and event triggers owned by a superuser the restore does not
  run as). They do not touch application data, which is why this script
  asserts on row counts rather than on an error count.
NOTE

echo
if (( failures > 0 )); then
  echo "RESULT: ${failures} check(s) FAILED — this backup is not trustworthy"
  exit 1
fi
echo "RESULT: the newest backup restores and matches the live database"
