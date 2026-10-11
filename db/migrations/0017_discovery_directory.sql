-- Services Directory: browse suppliers WITHOUT a location.
--
-- `discovery.supplier_locations` was built for one question — "who is open
-- near me" — so lat/lng are mandatory and there is no way to page, search
-- by name, or filter by city. The Services Directory asks a different
-- question of the same data, so this widens the read model rather than
-- adding a bounded context: a directory is a query, not a domain.
--
-- Additive only. Every column is nullable or defaulted, the existing geo
-- index is untouched, and `GET /v1/discovery/suppliers` keeps behaving
-- exactly as the shipped app expects.

alter table discovery.supplier_locations
  add column if not exists city text,
  add column if not exists country char(2),
  add column if not exists rating numeric(2,1);

-- Name search. pg_trgm rather than tsvector: supplier names are short
-- proper nouns ("Garage Benali"), often mistyped, and rarely benefit from
-- stemming or stop-words. Trigram similarity also makes ILIKE '%x%'
-- indexable, which a tsvector cannot do.
create extension if not exists pg_trgm;
create index if not exists supplier_locations_name_trgm_idx
  on discovery.supplier_locations using gin (name gin_trgm_ops);

-- Directory browse is ordered by (name, supplier_id) for a stable cursor;
-- without the index every page is a sort of the whole table.
create index if not exists supplier_locations_name_idx
  on discovery.supplier_locations (name, supplier_id);

create index if not exists supplier_locations_city_idx
  on discovery.supplier_locations (city) where city is not null;

-- The read policy already covers these columns: it grants SELECT on the
-- whole row for `is_open` suppliers, so nothing here changes visibility.
