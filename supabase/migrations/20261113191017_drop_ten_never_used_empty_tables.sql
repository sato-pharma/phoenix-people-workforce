-- drop_ten_never_used_empty_tables
--
-- WHAT THIS CHANGES: drops ten tables in public that are empty and that nothing reads or
-- writes: no code in src/ or app/, no script, no database function, trigger or view, no foreign key
-- pointing at them (enterprise audit 2026-11-13, REC-040, S03; owner's decision 13 Nov 2026).
--
--   geo_bricks                   an early brick table (in the May 2026 RLS script); signed-in users still held insert, update and delete on it
--   leave_notification_attempts  no reader or writer
--   leave_request_events         no reader or writer
--   market_awareness_evidence    created with the Market Awareness module (20260906235500), no reader or writer
--   notification_event_reads     no reader or writer
--   platform_settings            no reader or writer
--   probation_feedback_comments  the retired legacy probation feedback (tests/probation-legacy-feedback-retired.test.ts)
--   rep_rank_day_facts           created with Phoenix Ranks (20261005210841), no reader or writer
--   rep_rank_kpi_months          created with Phoenix Ranks (20261005210841), no reader or writer
--   sidebar_module_assignments   personal sidebar layouts (20260828143000), no reader or writer
--
-- Production, measured 13 Nov 2026: each table counted 0 rows (count(*), not the statistics
-- estimate) and 0 inserts in the twelve days of counters. Two of them carried a foreign key to
-- public.employees(hr_id) (geo_bricks.employee_hr_id, probation_feedback_comments.commenter_hr_id);
-- those keys leave scripts/employee-key-baseline.json in the same change.
--
-- Each drop is guarded: it counts the table again inside this transaction and stops the whole
-- migration if a row has appeared. No CASCADE: a view or key that depends on one of them stops it too.
--
-- ROLLBACK: recreate a table from its definition in supabase/schema/production.sql as of commit
-- 06166dbf5 (or its creating migration). Nothing is lost: every table was empty.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

set local lock_timeout = '5s';

do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array[
    'geo_bricks',
    'leave_notification_attempts',
    'leave_request_events',
    'market_awareness_evidence',
    'notification_event_reads',
    'platform_settings',
    'probation_feedback_comments',
    'rep_rank_day_facts',
    'rep_rank_kpi_months',
    'sidebar_module_assignments'
  ] loop
    if to_regclass('public.' || t) is null then
      raise notice '% is already gone', t;
      continue;
    end if;
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'public.% now holds % row(s); nothing was dropped', t, n;
    end if;
    -- SAFE: the table was counted empty in this same transaction, and nothing reads or writes it
    execute format('drop table public.%I', t);
  end loop;
end
$$;

commit;
