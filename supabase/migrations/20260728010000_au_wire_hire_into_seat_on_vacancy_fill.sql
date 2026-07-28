-- =============================================================================
-- au.hire_into_seat FINALLY HAS AN APPLICATION CALLER — the replacement-hire case
-- =============================================================================
-- GAP (documented in docs/area-unification/vacancy-models.md after PR #1399): resignations
-- reach the au seat model automatically (public.phx_resign_employee_and_open_vacancy calls
-- au.resign_occupant in the same transaction) but hires never did. au.hire_into_seat existed
-- and behaved correctly if called, but nothing called it — au.occupancy_history held 132
-- seed_baseline rows, 7 resignation_rpc rows, and exactly ONE hire_rpc row, created by the
-- owner BY HAND on 2026-07-27.
--
-- WHY THIS IS HARD: au.seats is a FIXED 132-seat model (seeded once, not created per hire), so
-- "hiring" here means filling an EXISTING vacant seat, not creating a new one. Nothing decides
-- WHICH seat_id a new employees row corresponds to. The obvious approach — resolve a seat from
-- the hire's line/area plus their job_title mapped to a seat_tier (REP/DM/RSM/NSM) — was
-- rejected on purpose: no such title -> tier mapping exists anywhere in this codebase, and
-- src/lib/employees/access-role.ts states outright why one shouldn't be invented: "a job title
-- is descriptive only and is NEVER a permission source... Auto-provisioned accounts therefore
-- always start at the least-privilege role." Building a string-matching heuristic here would be
-- the first thing in this codebase to trust job_title for something consequential.
--
-- THE SAFE CASE THIS MIGRATION HANDLES: a REPLACEMENT hire. public.position_vacancies already
-- carries replacement_for_hr_id — "HR_ID of the resigned/terminated employee whose position
-- opened this vacancy" — set by the exact same resignation flow that calls au.resign_occupant.
-- When src/lib/employees/vacancy-closer.ts's closeVacancyOnHire() later closes that vacancy
-- (status -> 'filled', filled_by_hr_id = the new hire), the departed predecessor's seat_id is
-- ALREADY on record in au.occupancy_history and is deterministically findable — zero title
-- matching, zero area/line guessing. This is exactly the "seat continuity" design the lifecycle
-- RPCs describe: "Hiring fills the same seat, so the new occupant inherits everything keyed to
-- that seat/area."
--
-- VERIFIED against production (read-only, before writing this): all SIX real open vacancies
-- from the original bug report — VAC-B176-SPK, VAC-AI0004-EQD, VAC-B169-IJ2, VAC-B171-CF1,
-- VAC-B111-7O7, VAC-B147-F85 (still unfilled as of 2026-07-28) — resolve via nothing but
-- replacement_for_hr_id + au.occupancy_history to exactly the six seats PR #1399 already fixed
-- (SEAT-AIF-REP-AB4/CA2, SEAT-PED-REP-D16/UE3, SEAT-CNS-REP-AB5/GZ2), all currently
-- 'vacant_will_hire'. When any of these is genuinely filled, this migration will correctly
-- re-occupy the right seat with zero further code changes.
--
-- AMBIGUITY GUARD: au.occupancy_history has no per-hr_id uniqueness (au.transfer_occupant
-- accumulates one closed 'person' row per seat ever held) — confirmed live: occupant 'b-1'
-- already has 2 person spans from an in-role transfer. au.f_last_occupied_seat_by_hr_id
-- therefore orders by effective_to DESC among CLOSED spans only, not a bare equality lookup:
-- resign_occupant only ever closes whichever seat a person currently holds, so the
-- most-recently-closed row is unambiguously "the seat they held immediately before leaving",
-- regardless of how many earlier seats/transfers precede it.
--
-- OUT OF SCOPE, DELIBERATELY (see docs/area-unification/vacancy-models.md):
--   * Brand-new headcount (a vacancy with NO replacement_for_hr_id) — no confident way to pick
--     a seat without the job_title heuristic rejected above. No-ops silently; not an error.
--   * Employee TRANSFERS between seats while remaining employed — au.transfer_occupant has no
--     application caller either, and this migration does not add one. Separate, still-open gap.
--
-- FAIL-SAFE BY CONSTRUCTION: hiring an employee is business-critical and must never fail
-- because of an internal reporting-model side effect. Every au.hire_into_seat call here is
-- wrapped in EXCEPTION WHEN OTHERS; the outer trigger has no unguarded path back to the
-- position_vacancies UPDATE that fired it.
--
-- OBSERVABILITY, AND ITS HONEST LIMIT: closeVacancyOnHire() clears replacement_for_hr_id to
-- NULL in the SAME UPDATE that sets status='filled' ("no longer pending replacement") — so by
-- the time any later query reads the closed vacancy row, the link this migration depends on is
-- already gone. This trigger writes a public.audit_logs row on both success and failure so the
-- outcome is durably recorded regardless. But it means au.f_line_area_occupancy_drift() cannot
-- detect "this trigger silently failed to fire": if it never runs, BOTH au.line_area_map and
-- au.occupancy_history simply keep agreeing that the seat is vacant, which is indistinguishable
-- from the seat genuinely still being open. No drift kind is added here that would claim
-- otherwise — that would be false confidence, not a real check. The audit_logs trail plus this
-- trigger's own correctness are the actual safety net.
--
-- Regression guard: tests/au-hire-into-seat-wiring.test.ts.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) The seat-resolution helper: the last seat a (now-departed) person held.
-- ---------------------------------------------------------------------------
create or replace function au.f_last_occupied_seat_by_hr_id(p_hr_id text)
returns text
language sql
stable
security definer
set search_path to 'au', 'public'
as $$
  select oh.seat_id
  from au.occupancy_history oh
  where oh.occupant_canonical_hr_id = lower(btrim(p_hr_id))
    and oh.node_type = 'person'
    and oh.effective_to is not null
  order by oh.effective_to desc
  limit 1;
$$;

comment on function au.f_last_occupied_seat_by_hr_id(text) is
  'The seat_id of the most recently CLOSED person-occupancy span for the given (normalized) HR_ID - i.e. the seat this person held immediately before their last resignation/transfer out. NULL if they never held an au seat. Deliberately restricted to CLOSED spans and ordered by effective_to, not effective_from: resign_occupant only ever closes the seat a person currently holds, so the most-recently-closed row is unambiguous regardless of how many earlier seats/transfers preceded it.';

revoke execute on function au.f_last_occupied_seat_by_hr_id(text) from public, anon, authenticated;
grant execute on function au.f_last_occupied_seat_by_hr_id(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2) The trigger function: fires when a vacancy is filled, only for a replacement hire.
-- ---------------------------------------------------------------------------
create or replace function public.phx_hire_into_seat_on_vacancy_filled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_predecessor_hr_id text := nullif(btrim(old.replacement_for_hr_id), '');
  v_new_hr_id text := nullif(btrim(new.filled_by_hr_id), '');
  v_seat_id text;
begin
  -- Brand-new headcount (no departed predecessor) or a fill with no recorded hirer -
  -- out of scope by design; not an error.
  if v_predecessor_hr_id is null or v_new_hr_id is null then
    return new;
  end if;

  v_seat_id := au.f_last_occupied_seat_by_hr_id(v_predecessor_hr_id);

  -- Predecessor never held an au seat (e.g. Head Office, or pre-dates the seat model) -
  -- nothing to hire into. Common and expected; not an error.
  if v_seat_id is null then
    return new;
  end if;

  begin
    perform au.hire_into_seat(
      v_seat_id, v_new_hr_id,
      coalesce((new.filled_at at time zone 'Africa/Cairo')::date, (now() at time zone 'Africa/Cairo')::date),
      'vacancy_fill_trigger'
    );
    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
    values (
      'system', 'au_seat_hire', v_new_hr_id,
      format('Auto-hired into au seat %s as replacement for %s via vacancy %s',
        v_seat_id, v_predecessor_hr_id, coalesce(new.vacancy_code, new.id::text)),
      jsonb_build_object(
        'seatId', v_seat_id, 'predecessorHrId', v_predecessor_hr_id,
        'vacancyId', new.id, 'vacancyCode', new.vacancy_code
      )
    );
  exception when others then
    -- Must never block the vacancy-fill transaction - onboarding cannot fail because of an
    -- internal reporting-model side effect. See the migration header for why this audit_logs
    -- row (not au.f_line_area_occupancy_drift) is the durable record of what happened here.
    raise warning 'phx_hire_into_seat_on_vacancy_filled: au.hire_into_seat(%, %) failed: %',
      v_seat_id, v_new_hr_id, sqlerrm;
    begin
      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
      values (
        'system', 'au_seat_hire_failed', v_new_hr_id,
        format('Failed to auto-hire into au seat %s as replacement for %s: %s',
          v_seat_id, v_predecessor_hr_id, sqlerrm),
        jsonb_build_object(
          'seatId', v_seat_id, 'predecessorHrId', v_predecessor_hr_id,
          'vacancyId', new.id, 'error', sqlerrm
        )
      );
    exception when others then
      null; -- audit logging itself must not be able to block hiring either
    end;
  end;

  return new;
end;
$$;

comment on function public.phx_hire_into_seat_on_vacancy_filled() is
  'Trigger on public.position_vacancies: when a REPLACEMENT vacancy (replacement_for_hr_id set) transitions to status=filled, hires filled_by_hr_id into the departed predecessors last au seat via au.hire_into_seat. No-ops (not an error) for brand-new headcount or a predecessor with no au seat. Never raises - a failure is caught, warned, and written to public.audit_logs so it can never block the vacancy-fill transaction.';

revoke execute on function public.phx_hire_into_seat_on_vacancy_filled() from public, anon, authenticated;
grant execute on function public.phx_hire_into_seat_on_vacancy_filled() to service_role;

-- ---------------------------------------------------------------------------
-- 3) The trigger itself.
-- ---------------------------------------------------------------------------
-- AFTER UPDATE (not BEFORE): this trigger only reads OLD/NEW and writes to au.* + audit_logs,
-- never the position_vacancies row itself, so there is nothing to intercept before the write.
-- The WHEN clause fires on the status transition regardless of what else the same UPDATE
-- statement changes in one PATCH (exactly how closeVacancyOnHire() writes it).
create or replace trigger trg_position_vacancies_hire_into_seat
  after update on public.position_vacancies
  for each row
  when (new.status = 'filled' and old.status is distinct from 'filled')
  execute function public.phx_hire_into_seat_on_vacancy_filled();

notify pgrst, 'reload schema';

commit;
