-- probation_covers_field_sales_managers
--
-- WHAT THIS CHANGES:
--   1. Replaces public.probation_provision_case_on_hire() (it serves BOTH the after-insert hire
--      trigger and the after-update-of-job_title/hire_date trigger on public.employees). The ONLY
--      change is the job-title guard: it used to open a case for a Medical Representative alone and
--      now opens one for every FIELD role - a Medical Representative, a District Sales Manager, a
--      Senior District Manager, a Regional Sales Manager or a National Sales Manager. Every other
--      line of the body is the one 20261022163301 wrote.
--   2. Opens the probation case each active (or on-leave) field SALES MANAGER hired inside the last
--      90 days should now have and does not - 8 District Sales Managers when this was written
--      (idempotent: on conflict do nothing). Medical Representatives are not touched here.
--
-- WHY: audit item REC-074. The owner decided on 13 Nov 2026 that automatic probation covers the
-- field roles ("Field roles only": Medical Reps plus the field managers; office roles stay manual)
-- and on 14 Nov 2026 named the titles ("All sales managers": District, Regional and National Sales
-- Managers) and asked that the managers already inside their 90 days get their case now ("Open the
-- 8 now"). This replaces the 2026-07-17 Medical-Representatives-only rule for those titles. The
-- same title list lives in src/lib/probation/intelligence/cases.ts (PROBATION_FIELD_ROLE_TITLES),
-- and tests/probation-case-provisioning.test.ts holds the two equal.
--
-- The Day 30/60/75 milestone notices of the new cases go to the owner alone, like every other case
-- (src/lib/probation/intelligence/milestone-emails.ts); a milestone a manager has already crossed
-- reaches him at the next morning run.
--
-- ROLLBACK: re-apply the function body from 20261022163301 (the 'medical rep' guard), then
--     delete from public.probation_cases where source = 'backfill_2026_11_14_field_managers'
--       and not exists (select 1 from public.probation_dv_days d where d.case_id = probation_cases.id);
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.
-- Additive: one function body replaced and 8 rows inserted; nothing is deleted or re-dated.

begin;

create or replace function public.probation_provision_case_on_hire()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_source text;
  v_line_name text;
  v_area_name text;
begin
  -- Which path provisioned this case. INSERT keeps the original label so existing rows and any
  -- reader keying on it are unaffected; a later correction is labelled distinctly so the audit
  -- trail never claims the hire trigger produced it.
  v_source := case when tg_op = 'INSERT' then 'hire_trigger' else 'hire_update_trigger' end;

  -- Guard: need identity + a hire date to anchor the window.
  if new.hr_id is null or new.hire_date is null then
    return new;
  end if;
  -- Guard: skip already-exited employees.
  if lower(coalesce(new.employment_status, 'active')) in ('terminated', 'resigned', 'inactive') then
    return new;
  end if;
  -- Guard: FIELD ROLES ONLY (owner, 13-14 Nov 2026, replacing the 2026-07-17 Medical-Reps-only rule):
  -- a Medical Representative or a District / Senior District / Regional / National Sales Manager.
  -- Office and head-office roles never get a case automatically. Substring match, so title variants
  -- ("Senior Medical Representative", "Senior District Manager") are covered. Same list as
  -- PROBATION_FIELD_ROLE_TITLES in src/lib/probation/intelligence/cases.ts.
  if lower(coalesce(new.job_title, '')) !~ '(medical rep|district manager|district sales manager|regional sales manager|national sales manager)' then
    return new;
  end if;
  -- Guard: only provision hires still inside the 90-day window (protects bulk imports of
  -- long-tenured staff from spawning spurious cases). Compared against Cairo's calendar day,
  -- not the DB session's (UTC) - see 20260725130000.
  if (new.hire_date + interval '90 days')::date <= (now() at time zone 'Africa/Cairo')::date then
    return new;
  end if;

  -- The line and the area are LINKS on the employee row (line_id, area_id); the name columns that
  -- used to sit beside them were dropped. Read the name through the link - a missing link yields a
  -- NULL name, never an error.
  select l.name into v_line_name from public.lines l where l.id = new.line_id;
  select a.name into v_area_name from public.areas a where a.id = new.area_id;

  begin
    insert into public.probation_cases (
      employee_hr_id, employee_name, job_title, line_name, area_name, manager_hr_id,
      hire_date, probation_start_date, probation_end_date, status, source, created_by
    ) values (
      new.hr_id, new.full_name, new.job_title, v_line_name, v_area_name, new.manager_hr_id,
      new.hire_date, new.hire_date, (new.hire_date + interval '90 days')::date,
      'active', v_source, 'system'
    )
    on conflict (employee_hr_id) do nothing;
  exception when others then
    -- Provisioning must NEVER block a hire, or an ordinary employee edit. Record and continue.
    begin
      insert into public.probation_provisioning_failures (employee_hr_id, source, error_message)
      values (new.hr_id, v_source, sqlerrm);
    exception when others then
      null; -- even the failure-log insert must not break the write
    end;
  end;

  return new;
end;
$function$;

-- A public SECURITY DEFINER function is never callable by the browser roles.
revoke execute on function public.probation_provision_case_on_hire() from public, anon, authenticated;
grant execute on function public.probation_provision_case_on_hire() to service_role;

-- The field sales managers already inside their 90 days: active (or on-leave), no case yet. Same shape
-- the trigger writes. Medical Representatives are left alone (20261022163301 already covered them).
insert into public.probation_cases (
  employee_hr_id, employee_name, job_title, line_name, area_name, manager_hr_id,
  hire_date, probation_start_date, probation_end_date, status, source, created_by
)
select e.hr_id, e.full_name, e.job_title, l.name, a.name, e.manager_hr_id,
       e.hire_date, e.hire_date, (e.hire_date + interval '90 days')::date,
       'active', 'backfill_2026_11_14_field_managers', 'system'
from public.employees e
left join public.lines l on l.id = e.line_id
left join public.areas a on a.id = e.area_id
where lower(coalesce(e.job_title, '')) ~ '(district manager|district sales manager|regional sales manager|national sales manager)'
  and lower(coalesce(e.employment_status, '')) in ('active', 'on_leave')
  and e.hire_date is not null
  and (e.hire_date + interval '90 days')::date > (now() at time zone 'Africa/Cairo')::date
on conflict (employee_hr_id) do nothing;

commit;
