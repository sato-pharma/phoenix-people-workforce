-- Fix: phx_reconcile_stale_replacement_vacancies() must respect area, and must never
-- record one employee as filling two seats.
--
-- BUG (confirmed in production 2026-08-01)
-- ----------------------------------------
-- This function runs on EVERY employee insert (trigger
-- phx_employee_insert_reconcile_stale_vacancies) and scans ALL open replacement
-- vacancies. For each one it tried to answer "was the departed person's seat already
-- filled by a replacement?" by matching a candidate on manager + line + job_title ONLY.
-- It did NOT constrain the candidate to the vacancy's AREA, and it did NOT check whether
-- the chosen candidate was already filling another seat. As a result a new hire who was
-- explicitly assigned area X could be recorded as "the replacement" for a resigned
-- predecessor in a DIFFERENT area Y — closing area Y's replacement vacancy and (via the
-- position_vacancies -> au seat trigger) binding the hire to the wrong seat, while
-- employees.area_id stayed X. One hire then showed up filling two position_vacancies.
--
-- Note: the sibling trigger phx_autofill_replacement_vacancy_from_employee_insert() and
-- the app-side closeVacancyOnHire() were NOT the cause — both already filter on area.
-- The cross-area matching lived only in THIS reconciliation function.
--
-- Incident: AI-0005 (Cairo West, area 1099) was recorded filling both vacancy 1 (Cairo
-- West) and vacancy 300 (Nasr City, area 1095, "for AI-0004"). Vacancy 300 was closed by
-- exactly this function's area-blind match. Pre-existing cross-area mis-fills produced the
-- same way and still present at fix time: vacancies 248 & 297 (AI-0003), 263 (AI-0006),
-- 173 & 299 (B-189). Those rows are DATA to be remediated separately; this migration only
-- stops NEW occurrences.
--
-- FIX
-- ---
-- (1) Area guard: a candidate only counts as the seat's replacement when their area
--     matches the vacancy's area (is-not-distinct-from, so a NULL vacancy area only
--     matches a NULL candidate area — conservative, never cross-fills).
-- (2) Single-seat guard: never pick a candidate who already actively fills another
--     vacancy (status='filled'), so one hire can close at most one seat. (Updates made
--     earlier in the same loop are visible to later iterations, so this also prevents one
--     candidate closing two vacancies within a single run.)
--
-- Everything else — the eligibility gate, ownership reassignment, note text, return
-- shape and the undefined_column guard — is unchanged. CREATE OR REPLACE preserves the
-- existing SECURITY DEFINER grants (service_role only).

create or replace function public.phx_reconcile_stale_replacement_vacancies() returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_checked integer := 0;
  v_closed integer := 0;
  r record;
  v_replacement record;
  v_effective_date date;
begin
  for r in
    select
      v.id as vacancy_id,
      v.area_id as vacancy_area_id,
      d.hr_id as departed_hr_id,
      d.manager_hr_id as departed_manager_hr_id,
      d.line_id as departed_line_id,
      d.job_title as departed_job_title,
      coalesce(d.last_working_date, d.resignation_date) as departed_effective_date
    from public.position_vacancies v
    join public.employees d on d.hr_id = v.replacement_for_hr_id
    where lower(coalesce(v.status, 'open')) = 'open'
      and nullif(trim(coalesce(v.replacement_for_hr_id, '')), '') is not null
      and d.manager_hr_id is not null
      and d.line_id is not null
      and nullif(trim(coalesce(d.job_title, '')), '') is not null
  loop
    v_checked := v_checked + 1;

    select a.hr_id
    into v_replacement
    from public.employees a
    where a.manager_hr_id = r.departed_manager_hr_id
      and a.line_id = r.departed_line_id
      and lower(trim(a.job_title)) = lower(trim(r.departed_job_title))
      -- (1) Area guard: the replacement must sit in the seat's own area.
      and a.area_id is not distinct from r.vacancy_area_id
      and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
      and a.hr_id <> r.departed_hr_id
      and (
        r.departed_effective_date is null
        or a.hire_date is null
        or a.hire_date >= r.departed_effective_date
      )
      -- (2) Single-seat guard: never assign someone who already ACTIVELY fills another
      --     seat (status='filled' only — cancelled rows can carry a stale filled_by_hr_id,
      --     and excluding on those would wrongly skip a legitimate reconciliation).
      and not exists (
        select 1
        from public.position_vacancies pv2
        where pv2.filled_by_hr_id = a.hr_id
          and pv2.id <> r.vacancy_id
          and lower(coalesce(pv2.status, 'open')) = 'filled'
      )
    order by a.hire_date asc nulls last
    limit 1;

    if found then
      update public.position_vacancies
      set
        status = 'filled',
        filled_by_hr_id = v_replacement.hr_id,
        filled_at = now(),
        replacement_for_hr_id = null,
        note = concat_ws(
          E'\n',
          nullif(note, ''),
          'Auto-closed by stale-replacement-vacancy reconciliation: seat for '
            || r.departed_hr_id || ' was already filled by ' || v_replacement.hr_id
            || ' on ' || current_date::text || '.'
        ),
        updated_at = now()
      where id = r.vacancy_id;

      v_closed := v_closed + 1;
    end if;
  end loop;

  return jsonb_build_object('checked', v_checked, 'closed', v_closed);
exception
  when undefined_column then
    raise notice 'Stale-replacement-vacancy reconciliation skipped because expected lifecycle/vacancy columns are missing.';
    return jsonb_build_object('applied', false, 'reason', 'missing_schema_column');
end;
$$;

-- CREATE OR REPLACE preserves existing grants (baseline already revoked PUBLIC and granted
-- service_role), but re-assert the lockdown so this migration is self-sufficient and passes the
-- SECURITY DEFINER revoke guard: a public SECURITY DEFINER function inherits EXECUTE to PUBLIC by
-- default, and anon/authenticated inherit it via PUBLIC membership. This function is only ever run
-- through the SECURITY DEFINER insert trigger (never as a REST RPC), so revoking is safe —
-- service_role keeps EXECUTE and the trigger keeps firing unchanged. Idempotent.
revoke execute on function public.phx_reconcile_stale_replacement_vacancies() from public, anon, authenticated;
