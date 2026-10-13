#!/usr/bin/env bash
#
# Nightly Postgres backup for the JustGo deployment.
#
# WHY THIS EXISTS. The database holds a gapless fiscal invoice series, the
# complaint history and the driver verification decisions. The fiscal series in
# particular cannot be reconstructed: invoice numbers must not have gaps, so a
# restore from application state is not possible even in principle. Before this
# script there was no crontab and no dump anywhere on the box.
#
# Two artefacts per run, because one is not restorable on its own:
#   globals  — roles and their passwords (pg_dumpall --globals-only)
#   database — every schema and its data (pg_dump)
# A dump without the globals restores into a database whose grants reference
# roles that do not exist, and every RLS policy silently fails to apply.
#
#   ./backup-db.sh            # dump, verify, rotate
#   ./backup-db.sh --verify   # check the newest backup and exit
#
# Install (as root on the box):
#   cp scripts/backup-db.sh /opt/justgo/backup-db.sh && chmod +x /opt/justgo/backup-db.sh
#   ( crontab -l 2>/dev/null; echo '17 2 * * * /opt/justgo/backup-db.sh >> /opt/justgo/backups/backup.log 2>&1' ) | crontab -
set -euo pipefail

CONTAINER="${PG_CONTAINER:-justgo-supabase-db}"
# supabase_admin, NOT postgres, and this is not cosmetic.
#
# `auth` is owned by supabase_admin and postgres is not a superuser in this
# image. A dump taken and restored as postgres silently loses auth.users:
# the COPY data is in the file, but applying it is refused with
# "permission denied for schema auth" — which pg_dump reports as a
# restore-time error, not a backup-time one. The first restore test of this
# script came back with 44 live accounts and 0 restored, meaning a recovery
# would have produced a database where every profile exists and nobody can
# log in.
PGUSER="${PGUSER:-supabase_admin}"
PGDATABASE="${PGDATABASE:-postgres}"
DEST="${BACKUP_DIR:-/opt/justgo/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# Refuse to run below this much free space. This box also serves another
# client's website; filling the disk would take their site down with ours.
MIN_FREE_MB="${MIN_FREE_MB:-2048}"
# A cheap sanity gate, not the real check — the structural assertions in
# verify_dump() are. Measured rather than guessed: the first real run produced
# 130 KB gzipped (23 MB raw, mostly schema and indexes), so 50 KB sits well
# above anything truncated and well below a genuine dump. Raise it as the
# database grows; a floor that no longer bites is a floor that proves nothing.
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-50000}"

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "FAILED: $*"; exit 1; }

# Markers that prove the dump reached the end and contains what we care about.
# `pg_dump` writes its completion line last, so its presence rules out a dump
# that died halfway and left valid-looking SQL behind.
verify_dump() {
  local file="$1"
  local size
  size=$(stat -c%s "$file")
  (( size >= MIN_DUMP_BYTES )) || die "$file is only ${size} bytes"

  gzip -t "$file" || die "$file is not a valid gzip stream"

  local body
  body=$(gzip -dc "$file")
  grep -q 'PostgreSQL database dump complete' <<<"$body" \
    || die "$file has no completion marker — the dump was truncated"
  for schema in documents identity orders suppliers reclamations drivers social; do
    grep -q "CREATE SCHEMA ${schema};" <<<"$body" \
      || die "$file is missing the ${schema} schema"
  done
  # The fiscal series is the one thing that cannot be rebuilt. If the
  # documents table is absent the dump is structurally wrong, whatever its size.
  grep -q 'CREATE TABLE documents.documents' <<<"$body" \
    || die "$file does not contain documents.documents"
  log "verified $(basename "$file") (${size} bytes)"
}

if [[ "${1:-}" == "--verify" ]]; then
  newest=$(find "$DEST" -maxdepth 1 -name 'justgo-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)
  [[ -n "$newest" ]] || die "no backup found in $DEST"
  verify_dump "$newest"
  log "newest backup is $(( ( $(date +%s) - $(stat -c%Y "$newest") ) / 3600 )) hours old"
  exit 0
fi

mkdir -p "$DEST"
# The globals dump contains role password hashes, so neither it nor the
# directory holding it may be world-readable.
chmod 700 "$DEST"

free_mb=$(df -Pm "$DEST" | awk 'NR==2 {print $4}')
(( free_mb >= MIN_FREE_MB )) || die "only ${free_mb}MB free in $DEST, need ${MIN_FREE_MB}MB"

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
  || die "container $CONTAINER is not running"

stamp=$(date -u '+%Y%m%d-%H%M%SZ')
db_tmp="$DEST/.justgo-${stamp}.sql.gz.part"
globals_tmp="$DEST/.justgo-${stamp}.globals.sql.gz.part"
db_out="$DEST/justgo-${stamp}.sql.gz"
globals_out="$DEST/justgo-${stamp}.globals.sql.gz"
# A failed run must not leave a half-written file that looks like a backup.
trap 'rm -f "$db_tmp" "$globals_tmp"' EXIT

log "dumping $PGDATABASE from $CONTAINER"
# `docker exec` without -t so no TTY mangles the stream with carriage returns.
#
# OWNERSHIP AND GRANTS ARE KEPT. Stripping them (--no-owner --no-privileges)
# hands every object to whoever restores, which breaks the Supabase services:
# GoTrue connects as supabase_auth_admin and Storage as
# supabase_storage_admin, and neither can use a table it no longer owns.
#
# --clean --if-exists, because the realistic recovery is "bring up a fresh
# Supabase stack, then restore". That stack creates its OWN auth schema at the
# version frozen in its image, while the live one has been migrated forward by
# GoTrue. Without the DROPs, CREATE TABLE auth.users fails as "already
# exists", the COPY that follows mismatches the older column list, and every
# account is silently lost — the first restore test of this script came back
# with 44 live accounts and 0 restored. The dump has to be authoritative over
# whatever the target already believes.
docker exec -i "$CONTAINER" pg_dump -U "$PGUSER" -d "$PGDATABASE" --clean --if-exists \
  | gzip -9 > "$db_tmp"
docker exec -i "$CONTAINER" pg_dumpall -U "$PGUSER" --globals-only \
  | gzip -9 > "$globals_tmp"

# Verify BEFORE publishing the name and before rotating, so a bad dump can
# never evict a good one.
verify_dump "$db_tmp"
[[ -s "$globals_tmp" ]] || die "the globals dump is empty"
gzip -dc "$globals_tmp" | grep -q 'CREATE ROLE' || die "the globals dump has no roles"

mv "$db_tmp" "$db_out"
mv "$globals_tmp" "$globals_out"
chmod 600 "$db_out" "$globals_out"
trap - EXIT
log "wrote $(basename "$db_out") and $(basename "$globals_out")"

# Rotation runs only after a verified write, so a run that fails leaves the
# existing history untouched. `-mtime` rather than counting files: a day with
# two runs should not push out two days of history.
removed=$(find "$DEST" -maxdepth 1 -name 'justgo-*.sql.gz' -mtime "+${KEEP_DAYS}" -print -delete | wc -l)
log "rotation: removed ${removed} file(s) older than ${KEEP_DAYS} days"
log "on disk: $(find "$DEST" -maxdepth 1 -name 'justgo-*.sql.gz' ! -name '*.globals.sql.gz' | wc -l) database backup(s), $(du -sh "$DEST" | cut -f1) total"

# Only when a human is watching. From cron this would append the same twelve
# lines to the log every night and bury the one line that matters.
if [[ -t 1 ]]; then
  cat <<'NOTE'

  These backups are on the SAME DISK as the database. That protects against a
  bad migration or a dropped table; it does not protect against losing the
  box. Copy them somewhere else, along with /opt/justgo/doc-signing.key —
  without that key every invoice ever issued becomes unverifiable:

    scp -r root@168.231.87.48:/opt/justgo/backups ./
    scp root@168.231.87.48:/opt/justgo/doc-signing.key ./

NOTE
fi
