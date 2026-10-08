-- probation_dv_visit_in_each_chain_evaluators_day
--
-- WHAT THIS CHANGES: probation_dv_visits' uniqueness moves from (crm_visit_id) to
-- (crm_visit_id, dv_day_id). One CRM visit may now be the detail row of more than one DV-Day — one
-- per evaluator on it — and still never twice under the same DV-Day.
--
-- WHY: owner, 2026-10-08 — a chain visit (one rep, two managers, saved by Phoenix CRM as ONE row) is
-- one visit for the rep and is in BOTH managers' records. The probation sync now gives the second
-- manager his own DV-Day for it, exactly as the first has. Under UNIQUE (crm_visit_id) that day's
-- visit rows were silently dropped by the writer's ON CONFLICT DO NOTHING, so the day would show no
-- visits behind it. No existing row changes: every crm_visit_id is unique today, so it is unique per
-- (crm_visit_id, dv_day_id) too. No data is rewritten or removed.
--
-- 🔴 ORDER: APPLY ONLY AFTER THE CODE THAT WRITES (crm_visit_id, dv_day_id) IS SERVING (`/api/healthz`
-- `revision`). The code before it upserts ON CONFLICT (crm_visit_id); once that constraint is gone the
-- write answers 42P10, AFTER the day rows are already written, and a later run skips an existing day,
-- so those days would keep no visits for good. The new code falls back to (crm_visit_id) on 42P10, so
-- code first, migration second is safe in any gap between them. (Applied and rolled back on staging
-- 2026-10-08 to prove both directions; staging carries the old constraint until then too.)
--
-- ROLLBACK (only while no crm_visit_id is attached to two DV-Days — check first with
--   select crm_visit_id from public.probation_dv_visits group by 1 having count(*) > 1;):
--   alter table public.probation_dv_visits drop constraint if exists probation_dv_visits_crm_visit_day_key;
--   alter table public.probation_dv_visits add constraint probation_dv_visits_crm_visit_id_key unique (crm_visit_id);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.probation_dv_visits drop constraint if exists probation_dv_visits_crm_visit_id_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.probation_dv_visits'::regclass
      and conname = 'probation_dv_visits_crm_visit_day_key'
  ) then
    alter table public.probation_dv_visits
      add constraint probation_dv_visits_crm_visit_day_key unique (crm_visit_id, dv_day_id);
  end if;
end
$$;

commit;
