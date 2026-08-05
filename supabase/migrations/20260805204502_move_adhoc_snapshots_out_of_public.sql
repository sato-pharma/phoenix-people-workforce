-- APPLIED BY HAND TO BOTH DATABASES ON 2026-08-05, THEN WRITTEN BACK HERE.
--
-- Ledger identity: production version 20260805204502, staging version 20260805204531 (same `name`,
-- 29 seconds apart, because each apply is stamped with the client's own clock). The filename carries
-- the PRODUCTION version so the file and the live migration share one identity, matching
-- 20260805195425_drop_finished_backup_snapshots_from_public. scripts/check-migrations-applied.ts
-- falls back to matching on `name`, so the differing staging version is not drift.
--
-- Move the last four ad-hoc snapshots out of the anon-reachable `public` schema.
--
-- WHAT THIS CLOSES. 20260805195425_drop_finished_backup_snapshots_from_public dropped four spent
-- snapshots and recorded that seven others remained in `public`. These are four of those seven. The
-- remaining three (field_workforce_compliance_live_snapshots, sales_ops_dashboard_snapshot,
-- sos_import_coverage_snapshots) are live application tables that carry policies and are read by
-- the app -- they are named "snapshot" but are not point-in-time copies, and are deliberately left
-- exactly where they are.
--
-- WHY MOVE RATHER THAN DROP. The owner has not finished with these four. They hold 1,542 rows of
-- CRM re-attribution rollback state and 772 brick centroids -- the only surviving record of what
-- those two live fixes changed. Dropping them would throw away the undo; moving them keeps every
-- row and removes the exposure. (Both geo tables hold 772 rows. An earlier pre-flight reported one
-- of them as empty; that came from `reltuples`, the planner's estimate, which is 0 for a table that
-- has never been analysed. Exact counts were taken before and after the move and match.)
--
-- WHY THIS IS THE ACTUAL FIX AND NOT TIDYING. Verified on production 2026-08-05: all four still
-- hold live `anon` AND `authenticated` SELECT grants, inherited from the schema-wide default
-- privileges that apply to anything created in `public`. The only thing standing between the public
-- anon key and these rows is that RLS is on with zero policies, i.e. deny-by-default. That is one
-- `disable row level security`, or one over-broad policy, away from being world-readable -- and
-- three tables in this same family were already found exposed that way on 2026-08-01. `public` is
-- the only schema PostgREST serves, so relocating them ends the exposure structurally rather than
-- leaving it resting on a single switch staying in the right position. This is the pattern
-- scripts/check-sql-backup-placement.ts prescribes, and that the sos_backup_20260728 family and
-- direct_orders_backup_20260803 already follow.
--
-- Table privileges travel WITH a table through SET SCHEMA, so the stale anon/authenticated grants
-- are revoked explicitly afterwards. Revoked from the two NAMED roles and never from PUBLIC: a
-- `revoke ... from public` against a default ACL also strips service_role, which is the role the
-- application itself connects as.
--
-- Reversible in one statement per table: `alter table <schema>.<name> set schema public;` restores
-- the previous placement exactly. (It would also restore the exposure, which is rather the point of
-- not doing it.)
--
-- Re-running is safe. Every move is guarded by to_regclass, so on production after this has run it
-- is a no-op. On a database rebuilt from supabase/migrations the two schemas are created empty and
-- nothing is moved, because no migration in this repo creates these tables -- they were made by
-- hand during live incident fixes.
--
-- Verified after applying:
--   production -- 0 tables matching either name pattern remain in `public`; all four now resolve in
--     their new schema with exact counts 1542 / 1258 / 772 / 772, unchanged from before the move;
--     `anon` has neither USAGE on the new schemas nor SELECT on any of the four tables.
--   staging -- held only the two geo tables; both moved, same checks pass. `crm_backup_20260801`
--     exists there as an empty schema, which is the documented rebuild behaviour above.

-- ── Destination schemas, named by domain and vintage to match the existing convention ──
create schema if not exists crm_backup_20260801;
revoke all on schema crm_backup_20260801 from anon, authenticated;
comment on schema crm_backup_20260801 is
  'Rollback state for the 2026-08-01 CRM re-attribution. Created by hand in public during the fix; moved out of public 2026-08-05 to take it off PostgREST. Not created by any migration.';

create schema if not exists geo_backup_20260728;
revoke all on schema geo_backup_20260728 from anon, authenticated;
comment on schema geo_backup_20260728 is
  'Brick centroid snapshots taken before the 2026-07-28 geo rebuild. Created by hand in public during the fix; moved out of public 2026-08-05 to take it off PostgREST. Not created by any migration.';

-- ── The moves themselves, each a no-op when the table is already gone from public ──
do $$
begin
  if to_regclass('public.crm_restamp_backup_20260801') is not null then
    execute 'alter table public.crm_restamp_backup_20260801 set schema crm_backup_20260801';
  end if;

  if to_regclass('public.crm_restamp_checkins_backup_20260801') is not null then
    execute 'alter table public.crm_restamp_checkins_backup_20260801 set schema crm_backup_20260801';
  end if;

  if to_regclass('public.geo_locations_brick_centroid_backup_20260728') is not null then
    execute 'alter table public.geo_locations_brick_centroid_backup_20260728 set schema geo_backup_20260728';
  end if;

  if to_regclass('public.geo_locations_brick_centroid_backup2_20260728') is not null then
    execute 'alter table public.geo_locations_brick_centroid_backup2_20260728 set schema geo_backup_20260728';
  end if;
end $$;

-- ── Strip the grants that rode along with the tables ──
revoke all on all tables in schema crm_backup_20260801 from anon, authenticated;
revoke all on all tables in schema geo_backup_20260728 from anon, authenticated;
