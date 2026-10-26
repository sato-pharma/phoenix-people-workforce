-- A guard, run at apply time, that the server-only tables really are server-only.
--
-- WHAT (audit 2026-10-26, point 13)
--   The advisor reports rls_enabled_no_policy for every table that has row security on and no policy
--   (267 on production on 2026-10-26, 272 after this change set). The baseline ACCEPTS them as the
--   deny-all shape: server-only tables the browser can never read because no policy lets a row
--   through. That acceptance is only true if none of them also hands a browser role a privilege that
--   row security does not filter (TRUNCATE) or that becomes live the moment someone adds a policy.
--   The same holds for tables with row security OFF outside Supabase's own schemas, and for the ~130
--   dated backup schemas on production.
--
--   Measured on production and staging on 2026-10-26, all three are clean:
--     - tables with row security on, no policy, and any browser-role privilege: 0
--     - tables with row security off and any browser-role privilege:           0
--     - backup-named schemas a browser role can USE or CREATE in:                0
--   So there is nothing to revoke. This migration turns that measurement into a check with teeth: it
--   RAISES, naming the relations, if any of the three is non-zero when it is applied — so a drift
--   between this measurement and the apply cannot pass silently.
--
--   The other half lives in the repo: scripts/check-migrations.mjs rule 6 refuses a migration that
--   creates a schema without revoking it from anon and authenticated in the same file (the gap that
--   left notification_backup_20261023 unrevoked — fixed in 20261026120100).
--
-- WHICH SCHEMAS ARE OUT OF SCOPE
--   Supabase's own (auth, storage, realtime, graphql, graphql_public, extensions, vault, pgsodium,
--   supabase_functions, supabase_migrations, net, cron, pgbouncer, _realtime, _analytics) and the
--   Postgres catalogs. Their grants are Supabase's to manage, and `storage`/`realtime` are browser-
--   facing by design.
--
-- CHANGES NOTHING. RE-APPLY is a re-check. ROLLBACK: none.

do $$
declare
  v_found text;
  v_out_of_scope constant text[] := array[
    'pg_catalog', 'information_schema', 'pg_toast', 'auth', 'storage', 'realtime',
    'extensions', 'graphql', 'graphql_public', 'vault', 'pgsodium', 'pgsodium_masks',
    'supabase_functions', 'supabase_migrations', 'net', 'cron', 'pgbouncer',
    '_realtime', '_analytics'
  ];
begin

  select string_agg(c.oid::regclass::text, ', ' order by 1) into v_found
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and c.relrowsecurity
    and n.nspname <> all (v_out_of_scope)
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    and (
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    );
  if v_found is not null then
    raise exception 'refusing: server-only tables (row security on, no policy) still grant a browser role: %', v_found;
  end if;

  select string_agg(c.oid::regclass::text, ', ' order by 1) into v_found
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and not c.relrowsecurity
    and n.nspname <> all (v_out_of_scope)
    and (
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    );
  if v_found is not null then
    raise exception 'refusing: tables with row security OFF grant a browser role: %', v_found;
  end if;

  select string_agg(n.nspname, ', ' order by 1) into v_found
  from pg_namespace n
  where (n.nspname ~* '(backup|snapshot|_bak|archive)' or n.nspname ~ '^(phx_backup_|zz_)')
    and (
      has_schema_privilege('anon', n.oid, 'USAGE,CREATE')
      or has_schema_privilege('authenticated', n.oid, 'USAGE,CREATE')
    );
  if v_found is not null then
    raise exception 'refusing: backup schemas a browser role can use: %', v_found;
  end if;

  raise notice 'no server-only table, row-security-off table or backup schema is reachable by a browser role';
end
$$;
