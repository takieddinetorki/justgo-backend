-- Dropping a primary key does NOT clear the NOT NULL that Postgres implied
-- on its columns. scope_id must be nullable: a GLOBAL role assignment has
-- no scope by definition (§7 identity.user_roles).
alter table identity.user_roles alter column scope_id drop not null;
