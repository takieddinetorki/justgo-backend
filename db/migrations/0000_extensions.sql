-- Workspace-wide extensions (§7). PostGIS ships in the postgis/postgis image
-- and in self-hosted Supabase's postgres image.
create extension if not exists pgcrypto;
create extension if not exists postgis;
