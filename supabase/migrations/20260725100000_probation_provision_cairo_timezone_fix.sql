-- Timezone fix (Cairo-vs-UTC audit, 2026-07-25): the 90-day provisioning-window guard in
-- probation_provision_case_on_hire() compares the hire+90 date against `current_date`, which
-- resolves in the database session's timezone (Supabase default: UTC), not Africa/Cairo. Since
-- Cairo is ahead of UTC, there is a nightly window where the DB's "today" still lags Cairo's
-- actual today — this can misjudge the exact 90-day boundary by one day, either silently
-- skipping provisioning a probation_cases row for a hire the app already considers past the
-- window, or vice versa.
--
-- Recreates the function with the SAME guard logic as the currently-live body — the live body
-- is the one from 20260717140000_probation_provision_medical_rep_only.sql (medical-rep-only
-- job-title guard + job_title insert column), which superseded 20260713131000's original; this
-- migration is NOT based on 20260713131000, which is stale. The only change is the date
-- comparison, now resolved via Africa/Cairo instead of the session timezone.
--
-- CREATE OR REPLACE FUNCTION preserves the function's existing OID and ACLs (as long as the
-- signature is unchanged and it is not dropped first), so the anon/authenticated EXECUTE revoke
-- from 20260719190000_phx_revoke_anon_executable_secdef_triggers.sql should already carry
-- forward on its own — but per the self-contained-migration policy established by
-- 20260719170000_phx_harden_public_function_default_execute.sql (see
-- tests/migrations-secdef-revoke-guard.test.ts), every migration that CREATEs a public SECURITY
-- DEFINER function must ALSO explicitly revoke EXECUTE FROM PUBLIC in the same file, rather than
-- relying on an earlier migration having done so. Re-issuing the identical revoke below is a
-- no-op if the prior one already held, and the explicit self-contained guarantee if it somehow
-- didn't.
--
-- NOT APPLIED as part of authoring this file — applying to any environment requires its own
-- separate explicit approval per this repo's operating rules.

begin;

create or replace function public.probation_provision_case_on_hire()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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
  -- not the DB session's (UTC) — see migration header.
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
      'active', 'hire_trigger', 'system'
    )
    on conflict (employee_hr_id) do nothing;
  exception when others then
    -- Provisioning must NEVER block a hire. Record and continue.
    begin
      insert into public.probation_provisioning_failures (employee_hr_id, source, error_message)
      values (new.hr_id, 'hire_trigger', sqlerrm);
    exception when others then
      null; -- even the failure-log insert must not break the hire
    end;
  end;

  return new;
end;
$$;

-- Self-contained revoke (policy: see header comment / tests/migrations-secdef-revoke-guard.test.ts).
-- PUBLIC is the operative grantee — every login role, including anon/authenticated, is a member
-- of PUBLIC, so revoking only anon/authenticated would be a no-op against the default PUBLIC grant.
revoke execute on function public.probation_provision_case_on_hire() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
