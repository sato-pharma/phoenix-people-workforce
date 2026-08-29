-- Probation provisioning also fires on UPDATE (2026-08-29).
--
-- THE DEFECT. The trigger installed by 20260713131000 (body last replaced by 20260725130000) is
-- AFTER INSERT ONLY, so it reads job_title and hire_date at the instant the employee row is
-- created. Any hire whose title or hire date is filled in by a LATER update -- which is what the
-- employee import and the multi-step hire form both do -- never reaches the provisioning branch
-- at all. It fails SILENTLY: no exception is raised, so probation_provisioning_failures stays
-- empty and the missing case is invisible until somebody goes looking for it.
--
-- MEASURED ON PRODUCTION 2026-08-29. Three active Medical Representatives inside the 90-day
-- window had no probation_cases row at all: AI-0005 (hired 2026-08-01), AI-0012 (2026-08-11) and
-- AI-0011 (2026-08-17). Four other Medical Reps hired in the same period DID get one, which is
-- what pins the cause to insert-time state rather than to the guards themselves. Those three
-- were backfilled by hand the same day (source = 'backfill'); this migration stops it recurring.
--
-- WHAT CHANGES. One new AFTER UPDATE OF (job_title, hire_date) trigger bound to the SAME
-- function. The guard logic is byte-for-byte the live body from 20260725130000; the only change
-- to the function is an operation-aware source label, so a case provisioned by a later
-- correction is not recorded as though the hire trigger produced it -- the same reasoning that
-- made the 2026-08-29 hand backfill use 'backfill' rather than 'hire_trigger'.
--
-- WHY IT IS SAFE TO FIRE ON EVERY TITLE / HIRE-DATE CHANGE:
--   * All four existing guards still run first and return early -- identity + hire date present,
--     not already exited, title contains 'medical rep', still inside the 90-day window.
--   * The insert keeps `on conflict (employee_hr_id) do nothing`. employee_hr_id is UNIQUE, so an
--     employee who already has a case -- including a CANCELLED or DECIDED one, which still
--     occupies that slot -- is never given a second case, and no existing case is overwritten,
--     re-dated or resurrected.
--   * The 90-day window guard is what stops a bulk title update across long-tenured staff from
--     spawning spurious cases. It was written for exactly that and is untouched here.
--   * The WHEN clause below restricts firing to a genuine value change: `update of <col>` fires
--     whenever the column appears in the SET list, even when the value is identical.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not RE-ANCHOR an existing active case when a hire
-- date is corrected. `on conflict do nothing` means a correction still leaves the case on its
-- original dates -- which is what happened to AI-0009 on 2026-08-29 and had to be repaired by
-- hand. Moving a probation end date moves a real HR review deadline, so that is a policy call for
-- the owner, not a side effect smuggled into a bug fix.
--
-- CREATE OR REPLACE FUNCTION preserves the function's OID and ACLs, but per the
-- self-contained-migration policy (see tests/migrations-secdef-revoke-guard.test.ts) every
-- migration that CREATEs a public SECURITY DEFINER function must ALSO re-issue the EXECUTE
-- revoke in the same file rather than relying on an earlier migration having done it.
--
-- NOT APPLIED as part of authoring this file -- applying to any environment requires its own
-- separate explicit approval per this repo's operating rules.

begin;

create or replace function public.probation_provision_case_on_hire()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
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

  begin
    insert into public.probation_cases (
      employee_hr_id, employee_name, job_title, line_name, area_name, manager_hr_id,
      hire_date, probation_start_date, probation_end_date, status, source, created_by
    ) values (
      new.hr_id, new.full_name, new.job_title, new.line_name, new.area_name, new.manager_hr_id,
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
$$;

-- The new leg. Named separately from trg_probation_provision_case_on_hire so both are visible in
-- \dS and either can be dropped independently.
drop trigger if exists trg_probation_provision_case_on_update on public.employees;
create trigger trg_probation_provision_case_on_update
after update of job_title, hire_date on public.employees
for each row
when (
  old.job_title is distinct from new.job_title
  or old.hire_date is distinct from new.hire_date
)
execute function public.probation_provision_case_on_hire();

-- Self-contained revoke (policy: see header comment / tests/migrations-secdef-revoke-guard.test.ts).
-- PUBLIC is the operative grantee — every login role, including anon/authenticated, is a member
-- of PUBLIC, so revoking only anon/authenticated would be a no-op against the default PUBLIC grant.
revoke execute on function public.probation_provision_case_on_hire() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
