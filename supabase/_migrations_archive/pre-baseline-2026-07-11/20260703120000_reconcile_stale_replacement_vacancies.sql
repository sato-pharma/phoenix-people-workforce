-- Reconcile stale "replacement needed" vacancies whose seat was already refilled.
--
-- The terminal-employee-vacancy-guard (20260527064308) opens a vacancy when an
-- employee's lifecycle status turns terminal. The auto-fill trigger
-- (20260515020940, phx_autofill_replacement_vacancy_from_employee_insert) is meant
-- to close it again once a new hire lands in the same footprint, but only fires on
-- INSERT and requires an EXACT match on area_id + line_id + position_id +
-- manager_hr_id — if any of those drift, the vacancy is silently orphaned open
-- forever even though the seat is filled. Confirmed in production: 3 Anti
-- infective DSM vacancies stayed open for weeks after their replacements were
-- hired (Cairo/B-101->AI-0001, Heliopolis/B-174->AI-0003, Sohag 2/B-150->B-189).
--
-- This is intentionally narrower than phx_autofill_replacement_vacancy_from_employee_insert:
-- it ONLY updates position_vacancies (status/filled_*/replacement_for_hr_id). It
-- does not touch employees, sales_records, sales_targets, or access tables — that
-- ownership-reassignment cascade (phx_reassign_replacement_ownership) is a
-- separate, higher-risk concern with its own intentionally strict guard and is
-- left untouched here.

create or replace function public.phx_reconcile_stale_replacement_vacancies()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checked integer := 0;
  v_closed integer := 0;
  r record;
  v_replacement record;
begin
  for r in
    select
      v.id as vacancy_id,
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
      and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
      and a.hr_id <> r.departed_hr_id
      and (
        r.departed_effective_date is null
        or a.hire_date is null
        or a.hire_date >= r.departed_effective_date
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

revoke execute on function public.phx_reconcile_stale_replacement_vacancies()
from public, anon, authenticated;
grant execute on function public.phx_reconcile_stale_replacement_vacancies()
to service_role;

-- Run once immediately: retroactively closes the confirmed stale vacancies.
select public.phx_reconcile_stale_replacement_vacancies();

-- VAC-BHISTM-8HQ is a distinct case handled outside the generic reconciler above:
-- its replacement_for_hr_id (B-HIST-MG) is a broken legacy record with no
-- manager_hr_id/line_id/job_title linkage, so the reconciler above correctly finds
-- no confident match and leaves it alone. Cancel it explicitly instead of guessing
-- at a replacement — the Anti infective Upper Egypt DSM seat has been actively
-- staffed by B-175 since 2026-03-24, months before this record was even entered.
update public.position_vacancies
set
  status = 'cancelled',
  note = concat_ws(
    E'\n',
    nullif(note, ''),
    'Cancelled by manual reconciliation: replacement_for_hr_id (B-HIST-MG) is a '
      || 'broken legacy record with no manager/line/hire-date linkage, so no '
      || 'confident replacement match is possible.'
  ),
  updated_at = now()
where vacancy_code = 'VAC-BHISTM-8HQ'
  and lower(coalesce(status, 'open')) = 'open';

-- Recurrence prevention: re-run the (cheap, vacancy-only) reconciler after every
-- new hire, independent of the stricter ownership-cascade trigger above, so a
-- position_id/area_id mismatch there can no longer orphan a vacancy indefinitely.
create or replace function public.phx_employee_insert_reconcile_stale_vacancies_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.phx_reconcile_stale_replacement_vacancies();
  return new;
end;
$$;

drop trigger if exists phx_employee_insert_reconcile_stale_vacancies on public.employees;
create trigger phx_employee_insert_reconcile_stale_vacancies
after insert on public.employees
for each row
execute function public.phx_employee_insert_reconcile_stale_vacancies_trigger();

notify pgrst, 'reload schema';
