-- =============================================================================
-- PHASE-9 OCCUPANCY RECONCILIATION against the live employee master
-- =============================================================================
-- GATED. Apply at cutover, AFTER the au seed (20260713040000) and once public.employees
-- is current, with a transaction DRY-RUN first (begin; \i this_file; read the NOTICE;
-- rollback). Touches ONLY au.occupancy_history — no public.* writes. Idempotent:
-- re-running is a no-op once reconciled (vacated seats are no longer 'person' rows;
-- effective_from already equals hire_date).
--
-- Fixes the two seed defects the pre-production audit flagged:
--   (a) STALE OCCUPANTS: seeded occupants who have since left still show as current
--       seat occupants and get sales attributed to them. -> VACATE those seats via
--       au.resign_occupant (correct close + vacant_placeholder + manager relink).
--   (b) FROZEN TENURE: every seeded row carried effective_from = '2026-07-13'. -> Reset
--       effective_from to each occupant's hire_date FROM THE EMPLOYEE MASTER.
--       Owner ruling 2026-07-18: "the employee hiring date is the hiring date in the
--       employee master only."
--
-- ATTRIBUTION SAFETY (verified): au.f_monthly_attribution selects the occupant whose
-- [effective_from, effective_to) window contains the period_end, and FALLS BACK to the
-- single baseline row when none matches. At cutover each seat has exactly one person
-- occupancy row, so backdating effective_from to the real hire_date credits the SAME
-- person for every period within their true tenure — it makes the window accurate and
-- introduces no historical mis-attribution.
--
-- HR_ID matched normalized (upper+trim); verified 102/102 clean on staging (no drift).
-- au.resign_occupant is service_role-only; this DO block runs as the migration owner.
-- =============================================================================

do $$
declare
  r         record;
  v_vacated int := 0;
  v_dated   int := 0;
begin
  ---------------------------------------------------------------------------
  -- (a) Vacate every seat whose CURRENT occupant is not active in the master
  --     (resigned/terminated) or is absent from the master entirely.
  ---------------------------------------------------------------------------
  for r in
    select o.seat_id,
           coalesce(e.last_working_date, e.resignation_date, current_date) as eff_date,
           case
             when e.hr_id is null then 'occupant not found in employee master'
             else 'occupant not active in employee master (' || coalesce(e.employment_status, 'null') || ')'
           end as why
    from au.occupancy_history o
    left join public.employees e
      on upper(btrim(e.hr_id)) = upper(btrim(o.occupant_hr_id))
    where o.effective_to is null
      and o.occupant_hr_id is not null
      and o.node_type = 'person'
      and (e.hr_id is null or coalesce(e.employment_status, '') <> 'active')
  loop
    perform au.resign_occupant(r.seat_id, r.eff_date,
                               'phase9 cutover reconcile: ' || r.why, 'phase9_reconcile');
    v_vacated := v_vacated + 1;
  end loop;

  ---------------------------------------------------------------------------
  -- (b) Reset effective_from to the master hire_date for every remaining active
  --     person-occupancy (owner rule). Rows with no hire_date in the master are
  --     left untouched (cannot invent a date).
  ---------------------------------------------------------------------------
  with upd as (
    update au.occupancy_history o
    set effective_from = e.hire_date
    from public.employees e
    where o.effective_to is null
      and o.occupant_hr_id is not null
      and o.node_type = 'person'
      and upper(btrim(e.hr_id)) = upper(btrim(o.occupant_hr_id))
      and e.hire_date is not null
      and o.effective_from is distinct from e.hire_date
    returning 1
  )
  select count(*) into v_dated from upd;

  raise notice 'FIX-D OK: vacated % stale seat(s); reset effective_from from master hire_date on % occupancy row(s).',
    v_vacated, v_dated;
end $$;
