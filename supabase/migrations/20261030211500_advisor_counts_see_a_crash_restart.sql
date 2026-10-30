-- phx_ci_advisor_counts(): the counter age sees a CRASH restart.
--
-- WHAT WENT WRONG. On 2026-10-29 at 14:04 Cairo production's Postgres crashed and restarted
-- (public.database_restarts). Crash recovery throws away every cumulative statistic, so every
-- index's idx_scan went back to 0 — but it does NOT stamp pg_stat_database.stats_reset, which
-- stayed NULL. stats_age_hours read only that column, so it answered -1 ("no reset recorded") and
-- scripts/check-advisor-baseline.ts told the reader the counters were long-accumulated. The next
-- morning's drift check judged unused_index on counters 18 hours old, over a weekend, read 815
-- against the accepted 755, and failed. Only 6 of the 807 "unused" indexes read that evening were
-- newer than 23 Oct: the jump was the wipe, not new indexes.
--
-- THE FIX. Crash recovery DOES stamp the fixed-size statistics — pg_stat_checkpointer,
-- pg_stat_bgwriter, pg_stat_wal and pg_stat_archiver all read 2026-10-29 11:04:25 UTC, the same
-- second as the restart. So the counter age is measured from the LATER of the two stamps.
-- greatest() ignores a NULL, so a database with neither stamp still answers -1, as before.
--
-- Every other line of the function is unchanged from the live definition (read with
-- pg_get_functiondef on production, 2026-10-30). Reports only; the check decides.

begin;
set local lock_timeout = '5s';

create or replace function public.phx_ci_advisor_counts()
returns table(category text, current_count integer)
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select 'rls_enabled_no_policy'::text, count(*)::integer
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and c.relrowsecurity
     and (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) = 0
     and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast',
                           'auth', 'storage', 'realtime', 'vault', 'extensions',
                           'graphql', 'graphql_public', 'cron', 'net', 'supabase_migrations')
     and n.nspname not like 'pg\\_%'
     and n.nspname not like 'pgsodium%'
     and n.nspname not like 'supabase\\_%'
  union all
  select 'function_search_path_mutable', count(*)::integer
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
                      where cfg like 'search_path=%')
     and not exists (select 1 from pg_catalog.pg_depend d
                      where d.objid = p.oid
                        and d.classid = 'pg_proc'::regclass
                        and d.deptype = 'e')
  union all
  select 'extension_in_public', count(*)::integer
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where n.nspname = 'public'
  union all
  select 'authenticated_security_definer_function_executable', count(*)::integer
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
  union all
  select 'unused_index', count(*)::integer
    from pg_catalog.pg_stat_user_indexes s
    join pg_catalog.pg_index i on i.indexrelid = s.indexrelid
   where s.idx_scan = 0
     and not i.indisunique
     and not i.indisprimary
     and not exists (select 1 from pg_catalog.pg_constraint ct where ct.conindid = i.indexrelid)
  union all
  select 'stats_age_hours',
         coalesce(extract(epoch from (now() - greatest(s.stats_reset, k.stats_reset))) / 3600, -1)::integer
    from pg_catalog.pg_stat_database s
   cross join pg_catalog.pg_stat_checkpointer k
   where s.datname = current_database();
$function$;

revoke execute on function public.phx_ci_advisor_counts() from public, anon, authenticated;
grant execute on function public.phx_ci_advisor_counts() to service_role;

commit;
