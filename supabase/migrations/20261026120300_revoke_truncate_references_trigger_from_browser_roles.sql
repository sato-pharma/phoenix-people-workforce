-- Take TRUNCATE, REFERENCES and TRIGGER on every table and view in `public` away from the two browser
-- roles, and change nothing else.
--
-- WHAT
--   On 2026-10-26 production had 55 relations in `public` (45 tables, 10 views; staging the same 55)
--   where anon or authenticated holds TRUNCATE, REFERENCES or TRIGGER — left over from the
--   `grant all` that Supabase's own default privileges hand out. No browser path needs any of the
--   three: TRUNCATE empties a table and skips row security entirely, REFERENCES lets a role build a
--   foreign key that probes another table's keys, TRIGGER lets a role attach a trigger. The app reads
--   and writes these tables through PostgREST with SELECT/INSERT/UPDATE/DELETE under row security,
--   and every one of those grants is left exactly as it is (the block counts them before and after).
--
-- WHY (audit 2026-10-26, point 10)
--   PostgREST cannot issue a TRUNCATE, so this is not reachable from the browser today. But a grant
--   the app never uses is a grant that only an attacker can use — through any SQL path that ever runs
--   as a browser role (an RPC with dynamic SQL, a future security-invoker function). TRUNCATE is the
--   one privilege row security does not filter.
--
-- THE DEFAULT PRIVILEGES
--   Every relation in `public` is owned by postgres (measured on both databases). postgres's own
--   default privileges in `public` already hand new tables to postgres and service_role only; the
--   statement after the block says so explicitly. The `supabase_admin` defaults, which DO include the
--   browser roles, cannot be changed by a postgres migration — a table created by supabase_admin
--   would arrive with them, which is why the block sweeps by catalog rather than by a fixed list.
--
-- RE-APPLY / OTHER DATABASES
--   The sweep reads the catalog, so it covers whatever relations this database has and is a no-op on
--   a second run. It RAISES if any relation in `public` still gives anon or authenticated TRUNCATE,
--   REFERENCES or TRIGGER, or if the number of relations either browser role can SELECT, INSERT,
--   UPDATE or DELETE changed.
--
-- ROLLBACK
--   grant truncate, references, trigger on table public.<relation> to anon, authenticated;  (per relation)

do $$
declare
  v_rel record;
  v_swept integer := 0;
  v_left integer;
  v_before text;
  v_after text;
  v_fingerprint constant text := $q$
    select string_agg(r || ':' || n, ',' order by r)
    from (
      select r, count(*)::text as n
      from (values ('anon'), ('authenticated')) as roles(r)
      cross join pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public'
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE')
      group by r
    ) as counted
  $q$;
begin
  set local lock_timeout = '5s';

  execute v_fingerprint into v_before;

  for v_rel in
    select c.oid::regclass::text as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (
        has_table_privilege('anon', c.oid, 'TRUNCATE,REFERENCES,TRIGGER')
        or has_table_privilege('authenticated', c.oid, 'TRUNCATE,REFERENCES,TRIGGER')
      )
    order by 1
  loop
    execute format('revoke truncate, references, trigger on table %s from public, anon, authenticated', v_rel.name);
    v_swept := v_swept + 1;
  end loop;

  select count(*) into v_left
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (
      has_table_privilege('anon', c.oid, 'TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated', c.oid, 'TRUNCATE,REFERENCES,TRIGGER')
    );
  if v_left > 0 then
    raise exception 'refusing: % relation(s) in public still give a browser role TRUNCATE, REFERENCES or TRIGGER', v_left;
  end if;

  execute v_fingerprint into v_after;
  if v_before is distinct from v_after then
    raise exception 'refusing: the browser roles'' select/insert/update/delete reach changed (% -> %)', v_before, v_after;
  end if;

  raise notice 'revoked truncate, references and trigger from the browser roles on % relation(s) in public', v_swept;
end
$$;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
