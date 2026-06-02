-- Fresh staging auth table API visibility.
-- Service-role server code must be able to reach auth/session tables through
-- PostgREST, while anon/authenticated remain governed by existing RLS/grants.

begin;

do $$
declare
  table_name text;
  service_role_tables text[] := array[
    'app_auth_users',
    'user_access_profiles',
    'auth_login_attempts',
    'app_sessions',
    'api_rate_limit_buckets',
    'password_setup_tokens',
    'audit_logs',
    'role_permission_overrides'
  ];
begin
  foreach table_name in array service_role_tables loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format(
        'grant select, insert, update, delete on table public.%I to service_role',
        table_name
      );
    end if;
  end loop;
end $$;

do $$
begin
  if to_regprocedure('public.api_rate_limit_consume(text, integer, integer)') is not null then
    revoke all on function public.api_rate_limit_consume(text, integer, integer) from public;
    grant execute on function public.api_rate_limit_consume(text, integer, integer) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
