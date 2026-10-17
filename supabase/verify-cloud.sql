-- Read-only deployment checks. Run against the Avana project after its migrations.
-- This query never reads task content, credentials or authentication tokens.
with domain_tables as (
  select c.oid, c.relname, c.relrowsecurity
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname like 'avana\_%'
), client_roles as (
  select oid, rolname from pg_catalog.pg_roles
  where rolname in ('anon', 'authenticated')
), rpc as (
  select p.oid, p.prosecdef, p.proconfig
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'avana_api'
)
select
  (select count(*) from domain_tables) as tables_expected_14,
  (select count(*) from domain_tables where relrowsecurity) as rls_expected_14,
  (select jsonb_object_agg(r.rolname, jsonb_build_object(
    'select_tables', (select count(*) from domain_tables t
      where has_table_privilege(r.oid, t.oid, 'SELECT')),
    'write_tables', (select count(*) from domain_tables t
      where has_table_privilege(r.oid, t.oid,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
    'public_usage', has_schema_privilege(r.oid, to_regnamespace('public'), 'USAGE'),
    'private_usage', has_schema_privilege(r.oid, to_regnamespace('avana_private'), 'USAGE'),
    'rpc_execute', has_function_privilege(r.oid,
      to_regprocedure('public.avana_api(text,text,jsonb,text,uuid)'), 'EXECUTE')
  )) from client_roles r) as client_permissions,
  (select count(*) from rpc) as rpc_signatures_expected_1,
  (select jsonb_agg(jsonb_build_object(
    'signature', oid::regprocedure::text,
    'security_definer', prosecdef,
    'config', proconfig
  )) from rpc) as rpc_details,
  (select count(*) from client_roles r
    cross join pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'avana_private'
      and has_function_privilege(r.oid, p.oid, 'EXECUTE')) as private_execute_expected_0,
  exists(select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime') as realtime_publication,
  exists(select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'avana_workspaces') as realtime_workspace;
