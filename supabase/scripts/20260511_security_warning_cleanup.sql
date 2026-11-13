-- Phoenix Workforce production security warning cleanup.
-- Keeps necessary SECURITY DEFINER functions locked down and tracked, and
-- normalizes public views to security_invoker mode where Postgres supports it.

begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table if not exists private.security_definer_function_exceptions (
  function_signature text primary key,
  schema_name text not null,
  function_name text not null,
  identity_arguments text not null,
  reason text not null,
  reviewed_at timestamptz not null default now(),
  reviewed_by text not null default current_user
);

revoke all on private.security_definer_function_exceptions from public, anon, authenticated;
grant select on private.security_definer_function_exceptions to service_role;

do $$
declare
  v_fn record;
  v_reason text;
begin
  for v_fn in
    select
      p.oid,
      p.oid::regprocedure::text as function_signature,
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
    order by p.proname, pg_get_function_identity_arguments(p.oid)
  loop
    execute format('revoke execute on function %s from public, anon', v_fn.oid::regprocedure);
    execute format('grant execute on function %s to service_role', v_fn.oid::regprocedure);

    if v_fn.function_name like 'current_access_%'
      or v_fn.function_name in ('current_phoenix_role') then
      execute format('grant execute on function %s to authenticated', v_fn.oid::regprocedure);
      v_reason := 'RLS helper intentionally remains SECURITY DEFINER so authenticated policies can read access profile metadata without recursion; execute is limited to authenticated and service_role.';
    else
      execute format('revoke execute on function %s from authenticated', v_fn.oid::regprocedure);
      v_reason := 'Privileged application RPC intentionally remains SECURITY DEFINER for service-role server workflows only; public, anon, and authenticated execute are revoked.';
    end if;

    insert into private.security_definer_function_exceptions (
      function_signature,
      schema_name,
      function_name,
      identity_arguments,
      reason,
      reviewed_at,
      reviewed_by
    )
    values (
      v_fn.function_signature,
      v_fn.schema_name,
      v_fn.function_name,
      v_fn.identity_arguments,
      v_reason,
      now(),
      current_user
    )
    on conflict (function_signature) do update
      set reason = excluded.reason,
          reviewed_at = excluded.reviewed_at,
          reviewed_by = excluded.reviewed_by;
  end loop;
end $$;

do $$
declare
  v_view record;
begin
  for v_view in
    select c.oid::regclass as view_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
  loop
    execute format('alter view %s set (security_invoker = true)', v_view.view_name);
  end loop;
end $$;

alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

commit;
