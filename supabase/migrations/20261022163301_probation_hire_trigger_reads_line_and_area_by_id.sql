-- probation_hire_trigger_reads_line_and_area_by_id
--
-- WHAT THIS CHANGES:
--   1. Replaces public.probation_provision_case_on_hire() so it reads the hire's line and area NAME
--      through employees.line_id / employees.area_id (lines.name / areas.name) instead of the
--      employees.line_name / employees.area_name columns, which no longer exist.
--   2. Creates the probation case every active Medical Representative hired inside the last 90 days
--      should already have and does not (idempotent: on conflict do nothing).
--   3. Marks the probation_provisioning_failures rows this defect wrote as resolved.
--
-- WHY: the 2026-10 dead-label-column drop removed employees.line_name and employees.area_name, but
-- the hire trigger still read new.line_name / new.area_name. Every INSERT or UPDATE OF
-- job_title/hire_date since 2026-09-30 raised "record new has no field line_name", the function's own
-- exception handler swallowed it into probation_provisioning_failures (19 unresolved rows) and the
-- hire went through with NO probation case. With no case there is no DV-Day anchor, so a probationer's
-- double visits are never recorded, his DV requirement never shows met, and the Day 30/60/75 and
-- SLA machinery never sees him. 13 reps hired 2026-10-01 .. 2026-10-18 and two hired for 24/25 Oct.
--
-- ROLLBACK: restore the previous function body (new.line_name / new.area_name) — which would break
-- every hire again, so do not. The cases created by step 2 can be removed with
--   delete from public.probation_cases where source = 'backfill_2026_10_22';
-- (no probation_dv_days / evaluations reference them yet at the moment this is applied).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Additive repair: one function body replaced and 15 rows inserted; nothing is deleted or re-dated.

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
  -- Guard: MEDICAL-REPRESENTATIVE-ONLY (owner rule 2026-07-17). Managers and head-office roles never
  -- get a probation case. Substring match covers "Medical Representative" + future variants.
  if position('medical rep' in lower(coalesce(new.job_title, ''))) = 0 then
    return new;
  end if;
  -- Guard: only provision hires still inside the 90-day window (protects bulk imports of
  -- long-tenured staff from spawning spurious cases). Compared against Cairo's calendar day,
  -- not the DB session's (UTC) — see 20260725130000.
  if (new.hire_date + interval '90 days')::date <= (now() at time zone 'Africa/Cairo')::date then
    return new;
  end if;

  -- The line and the area are LINKS on the employee row (line_id, area_id); the name columns that
  -- used to sit beside them were dropped. Read the name through the link — a missing link yields a
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

-- The cases the broken trigger never made: active (or on-leave) Medical Representatives still inside
-- their 90-day window with no case. Same shape the trigger writes; a declined offer is NOT backfilled.
insert into public.probation_cases (
  employee_hr_id, employee_name, job_title, line_name, area_name, manager_hr_id,
  hire_date, probation_start_date, probation_end_date, status, source, created_by
)
select e.hr_id, e.full_name, e.job_title, l.name, a.name, e.manager_hr_id,
       e.hire_date, e.hire_date, (e.hire_date + interval '90 days')::date,
       'active', 'backfill_2026_10_22', 'system'
from public.employees e
left join public.lines l on l.id = e.line_id
left join public.areas a on a.id = e.area_id
where position('medical rep' in lower(coalesce(e.job_title, ''))) > 0
  and lower(coalesce(e.employment_status, '')) in ('active', 'on_leave')
  and e.hire_date is not null
  and (e.hire_date + interval '90 days')::date > (now() at time zone 'Africa/Cairo')::date
on conflict (employee_hr_id) do nothing;

-- The failures this defect logged are resolved: 16 were hires the backfill above has now covered,
-- and 3 were declined offers that need no case.
update public.probation_provisioning_failures
   set resolved_at = now()
 where resolved_at is null
   and error_message like 'record "new" has no field "%line_name"';

commit;
