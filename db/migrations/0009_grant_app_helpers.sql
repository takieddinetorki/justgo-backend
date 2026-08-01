-- Every RLS policy calls app.account_id() / app.auth_user_id() / app.supplier_id(),
-- so the PostgREST roles must be able to reach them. Without these grants
-- every policy evaluation fails with "permission denied for schema app"
-- and RLS-protected reads return an error instead of rows.
grant usage on schema app to anon, authenticated, service_role;
grant execute on all functions in schema app to anon, authenticated, service_role;

-- keep future helpers usable without another migration
alter default privileges in schema app
  grant execute on functions to anon, authenticated, service_role;
