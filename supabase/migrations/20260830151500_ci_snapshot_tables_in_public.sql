-- Name a point-in-time snapshot sitting in `public` the day it appears.
--
-- WHY. `scripts/check-sql-backup-placement.ts` already fails a snapshot created in `public`,
-- but it reads `.sql` FILES — so it only ever sees a snapshot that arrives as a migration or a
-- committed script. That is not how they arrive here.
--
-- All five pre-images relocated out of `public` on 2026-08-30 by
-- 20260830133000_move_adhoc_pre_images_out_of_public.sql were created by hand through MCP
-- `execute_sql` during live fixes. No file was ever written, so the file-level check had nothing
-- to read and stayed green the whole time. What eventually surfaced them was `missing_primary_key`
-- in check-schema-shape.ts — which is a real signal but the wrong one, and it arrives late and by
-- accident:
--
--   * It is a side effect. A `create table ... as select` happens to carry no primary key, so the
--     snapshot is caught for a reason that has nothing to do with being a snapshot.
--   * It is silenceable by the wrong fix. Two migrations recorded on 2026-08-27 added primary keys
--     and RLS to the snapshots that existed that day. That cleared the error while leaving every
--     table exactly where it was — hardened, invisible, and still in the one schema PostgREST
--     serves. A snapshot that has been given a primary key is now reported by nothing at all.
--   * It says the wrong thing. "This table has no primary key" invites adding a primary key. The
--     house rule is that the table should not be in `public` at all
--     (docs/security/backup-table-placement.md).
--
-- So this asks the question directly, against the live database, however the table got there.
--
-- THE RULE IS NOT DEFINED HERE. It is scripts/lib/snapshot-name.ts, imported by both the
-- file-level check and the schema-shape check, and mirrored into the SQL below. Two enforcement
-- points, one definition — `tests/schema-shape-snapshot-in-public.test.ts` asserts the SQL text in
-- this function and the TypeScript regexes still agree, because a divergence is invisible in every
-- other way: each side would keep passing its own tests while disagreeing about what a snapshot is.
--
-- TWO TIERS, because one word list cannot separate a snapshot from a live table. STRONG words
-- (backup, bak, undo, rollback) are enough alone. WEAK words (snapshot, old, copy, tmp, temp,
-- orig, prev, pre) count only alongside a YYYYMMDD stamp, which is what makes a name a point in
-- time rather than a description of content. That gate is load-bearing: `sales_ops_dashboard_
-- snapshot` was a real application table, and early_birds_period_snapshots,
-- sos_import_coverage_snapshots and field_workforce_compliance_live_snapshots are live tables
-- today whose content happens to be snapshots. None carries a date, so none matches.
--
-- `pre` was added to the weak tier on 2026-08-30. It is the house convention for a rollback
-- pre-image and the rule was blind to it — of the five snapshots found that day, the two named
-- `zz_backup_…` matched on the strong tier and the three named `…_20260829_pre` matched nothing.
--
-- MEASURED before shipping, on both live databases rather than argued. With `pre` included the
-- rule flags all five of those names, plus the historical `crm_restamp_backup_20260801` and
-- `email_backfill_backup_20260730` exposures, and ZERO of the 319 production / 318 staging tables
-- in `public` as of 2026-08-30. It is therefore safe at severity "error": the check can only go red when
-- someone actually puts a snapshot in `public`, which is the entire intent. Nothing needed an
-- allowlist, and none is offered — the remedy is two statements and it is in the message.
--
-- Read-only, and returns names plus reachability, never row contents: the check needs to say
-- whether a browser-facing role can reach the table, which is the difference between "tidy this
-- up" and "act now". Deliberately no row count — reltuples is the planner's estimate and reads 0
-- for a table that has never been analysed, which has already misled one migration here.
--
-- Separate function rather than a new key on phx_ci_schema_shape, following
-- 20260811000600_pg_health_snapshot_expiry_gate.sql: a target that predates this migration
-- returns an error the script reads as "gate not deployed yet" and stays quiet, so the two
-- databases can be migrated independently without inventing a violation on the older one.

create or replace function public.phx_ci_snapshot_tables_in_public()
returns table (
  table_name text,
  anon_select boolean,
  authenticated_select boolean,
  rls_enabled boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    c.relname::text,
    -- to_regrole guards a database that has no Supabase browser roles at all (a local rebuild).
    -- has_table_privilege RAISES on an unknown role rather than returning null, which would turn
    -- a missing role into a failed check rather than a clean answer.
    case when to_regrole('anon') is null then false
         else has_table_privilege('anon', c.oid, 'SELECT') end,
    case when to_regrole('authenticated') is null then false
         else has_table_privilege('authenticated', c.oid, 'SELECT') end,
    c.relrowsecurity
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and (
      c.relname ~* '(^|_)(backup|backups|bak|undo|rollback)(_|$)'
      or (
        c.relname ~* '(^|_)(snapshot|old|copy|tmp|temp|orig|prev|pre)(_|$)'
        and c.relname ~ '(^|_)(19|20)[0-9]{6}(_|$)'
      )
    )
  order by c.relname;
$function$;

comment on function public.phx_ci_snapshot_tables_in_public() is
  'CI gate: point-in-time snapshot tables sitting in public, where PostgREST serves them. Rule mirrors scripts/lib/snapshot-name.ts; remedy is docs/security/backup-table-placement.md.';

-- A freshly created function gets a default ACL granting EXECUTE to PUBLIC. This one reports on
-- table reachability, so it is revoked to service_role only, matching every other phx_ci_* gate.
revoke execute on function public.phx_ci_snapshot_tables_in_public() from public, anon, authenticated;
grant execute on function public.phx_ci_snapshot_tables_in_public() to service_role;
