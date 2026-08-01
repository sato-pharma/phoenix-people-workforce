-- =============================================================================
-- THE APPROVALS-HUB RESIGNATION PATH MUST VACATE THE au SEAT TOO
-- =============================================================================
-- GAP (found 2026-08-01, follow-up to #1594): there are two ways an employee can leave.
--
--   A. Employees page  -> resignEmployeeAndOpenVacancy
--                      -> public.phx_resign_employee_and_open_vacancy
--                      -> step 5 vacates every open au seat.            CORRECT
--
--   B. POST /api/resignations, then Approvals Hub "complete"
--                      -> runResignationWorkflow(action: "complete")
--                      -> #1594 made this actually terminate the employee, and the
--                         existing trigger phx_employee_terminal_vacancy_guard opens the
--                         replacement position_vacancies row.
--                      -> but NOTHING closes the au occupancy span.     THE GAP
--
-- So under path B the organogram keeps showing the departed person sitting on their seat,
-- au.v_org_structure_kpis keeps counting the seat as occupied, and the area stays
-- 'occupied' instead of moving to 'vacant_will_hire'. That is the same
-- "vacated seat still reads as staffed" defect class #1399, #1411 and 20260728100000
-- have each been closing one surface at a time — this is the last uncovered surface.
--
-- WHY A NEW FUNCTION RATHER THAN CALLING THE EXISTING RPC: path B must NOT call
-- public.phx_resign_employee_and_open_vacancy, because that function inserts a second
-- public.employee_resignations row and a second position_vacancies row — path B already
-- created both. Only step 5 is missing, so only step 5 is extracted here.
--
-- WHY A public.phx_* WRAPPER RATHER THAN A DIRECT CALL: the au schema is not exposed on
-- PostgREST (see the same reasoning on public.au_v_line_area_occupancy_drift), and
-- verified 2026-08-01 no TypeScript under src/ references schema au at all. The whole au
-- model is driven from SQL, so application code can only reach it through a public
-- wrapper.
--
-- STEP 5 IS REPRODUCED HERE VERBATIM, INCLUDING BOTH OF ITS HARD-WON PROPERTIES:
--   * canonical match  — occupant_canonical_hr_id = lower(btrim(...)), NOT a raw
--     occupant_hr_id comparison. Confirmed on production 2026-08-01: all 97 open person
--     spans carry a canonical value and it is the lower-cased hr_id (PD-0006 -> pd-0006),
--     so a raw comparison is one casing difference away from silently vacating nothing.
--   * the LOOP  — not `limit 1`. au.occupancy_history has no per-hr_id uniqueness; B-1
--     holds two open spans at once (SEAT-AIF-REP-UE1 + SEAT-AIF-ADM-UE-1, both seeded
--     2021-04-01). A single-row vacate would close one and leave the other showing a
--     departed occupant forever. Re-verified on production 2026-08-01: still exactly one
--     such occupant. For every single-seat occupant the loop runs exactly once and the
--     behaviour is byte-identical.
--
-- IDEMPOTENCY: au.resign_occupant is NOT idempotent — it raises if the seat is unknown,
-- has no open span, or is already vacant. The loop IS the guard: when the employee holds
-- no open person-span (already vacated, or never had a seat) it iterates zero times and
-- the function returns seats_vacated = [] without calling au.resign_occupant at all. That
-- makes completing an already-terminated employee a harmless no-op, which is the normal
-- case when HR used the Employees page first. Confirmed on production 2026-08-01 that no
-- seat carries more than one open span, so au.resign_occupant's own re-lookup by seat_id
-- always resolves to the same person-span this loop selected.
--
-- CAIRO: p_effective_date is what closes the span, and every date in this system is
-- Africa/Cairo local (AGENTS.md § 4). The coalesce fallback is therefore explicitly
-- Cairo-zoned rather than an unzoned current_date, which is the exact bug the round-2
-- timezone audit flagged in nine other production SQL functions.
--
-- BLAST RADIUS ON TODAY'S DATA: none. This migration only creates a function; it updates
-- no row. Verified read-only on production 2026-08-01: 33 employees are in a terminal
-- lifecycle state and 0 of them still hold an open au seat, because every resignation so
-- far went through path A. The gap opens the first time HR completes a resignation raised
-- via POST /api/resignations.
--
-- ROLLBACK: this migration is additive and reversible with
--     drop function if exists public.phx_vacate_au_seats_for_employee(text,date,text,text);
--     notify pgrst, 'reload schema';
-- The paired application code treats a missing function as a non-fatal no-op
-- (isMissingSchemaMessage / PGRST202), so dropping it degrades path B back to exactly
-- today's behaviour rather than breaking the workflow.
--
-- Regression guard: tests/au-seat-occupant-resolver.test.ts section 6.
-- =============================================================================

begin;

create or replace function public.phx_vacate_au_seats_for_employee(
  p_actor text,
  p_effective_date date,
  p_employee_hr_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seat_id text;
  v_effective_date date;
  v_vacated text[] := array[]::text[];
begin
  if p_employee_hr_id is null or btrim(p_employee_hr_id) = '' then
    raise exception 'phx_vacate_au_seats_for_employee: employee hr_id is required';
  end if;

  v_effective_date := coalesce(p_effective_date, (now() at time zone 'Africa/Cairo')::date);

  -- Same lookup as step 5 of public.phx_resign_employee_and_open_vacancy: canonical HR_ID,
  -- open span only, person spans only, ordered for a stable and reproducible vacate order.
  -- Zero rows is the expected, non-error outcome for an employee who holds no seat.
  for v_seat_id in
    select seat_id
    from au.occupancy_history
    where occupant_canonical_hr_id = lower(btrim(p_employee_hr_id))
      and effective_to is null
      and node_type = 'person'
    order by seat_id
  loop
    perform au.resign_occupant(
      v_seat_id,
      v_effective_date,
      coalesce(nullif(btrim(p_reason), ''), 'resignation'),
      coalesce(nullif(btrim(p_actor), ''), 'system')
    );
    v_vacated := v_vacated || v_seat_id;
  end loop;

  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'effective_date', v_effective_date,
    'seats_vacated', to_jsonb(v_vacated),
    'vacated_count', coalesce(array_length(v_vacated, 1), 0)
  );
end;
$$;

-- The `public` schema has a project-wide default ACL that auto-grants EXECUTE to
-- `authenticated` on every new function (confirmed via pg_default_acl on both staging and
-- production) — `revoke ... from public` alone does NOT remove that direct grant. Both
-- revokes are required or this RPC is callable by any Supabase-authenticated session via
-- PostgREST, which would let any logged-in employee unseat anyone from the organogram.
-- The resulting ACL must read `postgres=X/postgres;service_role=X/postgres`, matching
-- public.phx_resign_employee_and_open_vacancy exactly.
revoke execute on function public.phx_vacate_au_seats_for_employee(text,date,text,text) from public;
revoke execute on function public.phx_vacate_au_seats_for_employee(text,date,text,text) from authenticated;
grant execute on function public.phx_vacate_au_seats_for_employee(text,date,text,text) to service_role;

notify pgrst, 'reload schema';

commit;
