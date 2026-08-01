-- Close a live exposure found by the schema-shape monitor on 2026-08-01 — the second of
-- this exact kind in one day, which is why the pattern is called out below rather than
-- just the incident.
--
-- public.crm_restamp_backup_20260801 (1,542 rows) and
-- public.crm_restamp_checkins_backup_20260801 (1,258 rows) are rollback records from the
-- CRM re-attribution work. Both were created with Supabase's default grants to
-- anon/authenticated and RLS was never enabled, so the PUBLIC anon key could read every
-- row: agent_name, agent_hr_id, visit_date and the double-visit partner ids for the reps
-- involved.
--
-- Enabling RLS with NO policies makes them deny-all for anon/authenticated while
-- service_role (rolbypassrls, verified on both projects) keeps full access — so whatever
-- created them can still read them and nothing server-side changes. Verified after
-- applying: acting as `anon`, visible rows went 1,542 -> 0 and 1,258 -> 0, with all rows
-- still stored, and production reached 286 of 286 tables with RLS enabled.
--
-- DELIBERATELY NOT DROPPING THEM. They are the rollback record for a re-attribution that
-- moved visits between reps — exactly the kind of change you want to be able to reverse
-- or audit. Drop them once that work has settled, together with their
-- NO_PRIMARY_KEY_ALLOWED entries in scripts/check-schema-shape.ts.
--
-- THE PATTERN, which matters more than either table: this is the third ad-hoc backup
-- table in three days to ship with default grants and no RLS
-- (email_backfill_backup_20260730 was the first). A table created outside a migration
-- inherits anon/authenticated grants from the schema default, and nothing in that path
-- prompts anyone to enable RLS. Closing them one at a time is not the fix — creating
-- such tables in a schema `anon` cannot reach, or enabling RLS in the same statement
-- that creates them, is.
--
-- Guarded so it is a clean no-op anywhere the tables do not exist (staging never had
-- them), which keeps this safe to replay on a rebuilt environment.

do $$
declare t text;
begin
  foreach t in array array['crm_restamp_backup_20260801', 'crm_restamp_checkins_backup_20260801']
  loop
    if to_regclass('public.' || quote_ident(t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      raise notice 'RLS enabled on %', t;
    else
      raise notice '% not present — nothing to do', t;
    end if;
  end loop;
end
$$;
