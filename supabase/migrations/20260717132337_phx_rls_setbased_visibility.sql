-- R-1: set-based RLS visibility — evaluate access checks once per query instead of once per row.
--
-- Context (2026-07-17 audit): 13 policies call private.phx_can_access_employee(<col>) PER ROW;
-- that function runs a 4-CTE query over employees and calls phx_current_role()/phx_current_scope()
-- (each hitting user_access_profiles/app_auth_users) for EVERY candidate row — measured ~4.7ms and
-- ~23 buffer reads per row (289-row outstation_expenses scan = 1.35s of pure policy evaluation).
--
-- Semantics are preserved BIT-FOR-BIT with the current effective behavior, including two quirks:
--  (1) private.phx_current_hr_id() reads the legacy PostgREST GUC request.jwt.claim.hr_id, which
--      nothing populates on current Supabase (PostgREST >= 9 sets request.jwt.claims JSON only),
--      so the self/team/line/department arms are dead today (fail closed). This migration keeps
--      the same helper, so behavior is unchanged now AND becomes correct if the claim is wired.
--  (2) The original self-arm compares lower(coalesce(X,'')) = lower(coalesce(actor,'')) — with a
--      NULL actor AND a NULL/empty row hr_id both sides are '' and the row is visible. Verified
--      2026-07-17: ZERO rows across all 13 tables have NULL/empty hr_id, so the quirk has no live
--      surface; the rewritten self-arm reproduces it anyway (reported separately as a latent bug).
--
-- Decomposition used (equivalent to the original phx_can_access_employee):
--   can_access_employee(X)
--     = company_access
--       OR ( (self(X) OR team(X) OR line(X) OR dept(X)) AND NOT resigned(X) )
-- where team/line/dept enumerate employees rows (set-valued, computed once per statement) and
-- resigned(X) is membership in the resigned/terminated/inactive/left set (computed once).
-- Zero-argument guard functions are wrapped in (select ...) so the planner hoists them to
-- InitPlans (evaluated once per statement instead of once per row).

-- ── Helper 1: hr_ids (lowercased) visible via the team / line / department arms ──
create or replace function private.phx_visible_hr_ids()
returns setof text
language sql stable security definer
set search_path to 'public'
as $$
  with me as (
    select lower(coalesce(private.phx_current_hr_id(), '')) as hr,
           private.phx_current_scope() as scope
  ),
  actor_row as (
    select e.line_id, e.department_id
    from public.employees e, me
    where me.hr <> '' and lower(e.hr_id) = me.hr
    limit 1
  )
  select lower(e.hr_id)
  from public.employees e, me
  where me.hr <> ''
    and (
      (me.scope in ('TEAM','HIERARCHY') and lower(coalesce(e.manager_hr_id, '')) = me.hr)
      or (me.scope in ('LINE','HIERARCHY') and e.line_id is not null
          and e.line_id = (select line_id from actor_row))
      or (me.scope in ('DEPARTMENT','SUPER_ADMIN') and e.department_id is not null
          and e.department_id = (select department_id from actor_row))
    );
$$;

-- ── Helper 2: hr_ids (lowercased) excluded by the lifecycle multiplier ──
create or replace function private.phx_resigned_hr_ids()
returns setof text
language sql stable security definer
set search_path to 'public'
as $$
  select lower(e.hr_id)
  from public.employees e
  where lower(coalesce(e.employment_status, 'active')) in ('resigned','terminated','inactive','left');
$$;

-- ── 13 policy rewrites (USING only; commands/roles unchanged) ──
-- TERM(X) below expands to the decomposition above.

alter policy employees_select_access on public.employees
using (
  (select private.phx_has_company_access())
  or (
    ( lower(coalesce(hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy employee_compensation_select_access on public.employee_compensation
using (
  (select private.phx_can_manage_payroll())
  or (select private.phx_has_company_access())
  or (
    ( lower(coalesce(employee_hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(employee_hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(employee_hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy employee_locations_select_access on public.employee_locations
using (
  (select private.phx_has_company_access())
  or (
    ( lower(coalesce(employee_hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(employee_hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(employee_hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy employee_probation_select_access on public.employee_probation
using (
  (select private.phx_has_company_access())
  or (
    ( lower(coalesce(employee_hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(employee_hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(employee_hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy outstation_expenses_select_access on public.outstation_expenses
using (
  (select private.phx_can_manage_payroll())
  or (select private.phx_has_company_access())
  or (
    ( lower(coalesce(hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy salary_records_select_access on public.salary_records
using (
  (select private.phx_can_manage_payroll())
  or (select private.phx_has_company_access())
  or (
    ( lower(coalesce(hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy salary_flags_select_access on public.salary_flags
using (
  (select private.phx_can_manage_payroll())
  or (select private.phx_has_company_access())
  or (
    ( lower(coalesce(hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy outstation_expense_requests_select_access on public.outstation_expense_requests
using (
  (select private.phx_can_manage_outstation())
  or (select private.phx_has_company_access())
  or (
    ( lower(coalesce(employee_hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(employee_hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(employee_hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy outstation_expense_reports_select_access on public.outstation_expense_reports
using (
  (select private.phx_can_manage_payroll())
  or exists (
    select 1 from public.outstation_expenses pe
    where pe.report_id = outstation_expense_reports.id
      and (
        (select private.phx_has_company_access())
        or (
          ( lower(coalesce(pe.hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
            or lower(coalesce(pe.hr_id,'')) in (select private.phx_visible_hr_ids()) )
          and not (lower(coalesce(pe.hr_id,'')) in (select private.phx_resigned_hr_ids()))
        )
      )
  )
);

alter policy salary_batches_select_access on public.salary_batches
using (
  (select private.phx_can_manage_payroll())
  or exists (
    select 1 from public.salary_records sr
    where sr.batch_id = salary_batches.id
      and (
        (select private.phx_has_company_access())
        or (
          ( lower(coalesce(sr.hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
            or lower(coalesce(sr.hr_id,'')) in (select private.phx_visible_hr_ids()) )
          and not (lower(coalesce(sr.hr_id,'')) in (select private.phx_resigned_hr_ids()))
        )
      )
  )
);

alter policy geo_bricks_select_access on public.geo_bricks
using (
  (select private.phx_has_company_access())
  or private.phx_can_access_line(line)
  or (select private.phx_can_manage_geo())
  or (
    ( lower(coalesce(employee_hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(employee_hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(employee_hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy brick_reference_rows_select_access on public.brick_reference_rows
using (
  (select private.phx_has_company_access())
  or private.phx_can_access_line(line)
  or (select private.phx_can_manage_geo())
  or (
    ( lower(coalesce(dsm_hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(dsm_hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(dsm_hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);

alter policy geo_trip_routes_select_access on public.geo_trip_routes
using (
  (select private.phx_has_company_access())
  or (select private.phx_can_manage_geo())
  or (
    ( lower(coalesce(employee_hr_id,'')) = (select lower(coalesce(private.phx_current_hr_id(),'')))
      or lower(coalesce(employee_hr_id,'')) in (select private.phx_visible_hr_ids()) )
    and not (lower(coalesce(employee_hr_id,'')) in (select private.phx_resigned_hr_ids()))
  )
);
