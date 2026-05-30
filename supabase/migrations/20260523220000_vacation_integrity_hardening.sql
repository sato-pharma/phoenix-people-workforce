-- Vacation integrity hardening.
--
-- Two risks addressed:
--
-- 1. Retroactive policy changes: the weekly-off policy stored in
--    v2_vacation_weekly_off_policies can be edited at runtime and would silently
--    change the duration calculation for existing approved requests on re-query.
--    Fix: snapshot the active policy into the request row at submission time.
--
-- 2. Duplicate requests: no database-level guard prevents the same employee from
--    submitting two pending/approved requests for the identical date range.
--    Fix: partial unique index on (employee_hr_id, start_date, end_date) where
--    status is not terminal.

-- (1) Policy snapshot column — stores the weekly-off policy in effect at the
--     moment the request was submitted so duration calculations remain stable.
alter table public.v2_vacation_requests
  add column if not exists weekly_off_policy_snapshot jsonb;
-- (2) Partial unique index preventing duplicate active requests.
--     Terminal statuses (rejected, cancelled) are excluded so employees can
--     re-submit after a rejection.
create unique index if not exists v2_vacation_requests_no_duplicate_active
  on public.v2_vacation_requests (employee_hr_id, start_date, end_date)
  where status not in ('rejected', 'cancelled');
-- Versioning for the weekly-off policy table: track when each row was last
-- changed so auditors can reconstruct the policy that was active on any date.
alter table public.v2_vacation_weekly_off_policies
  add column if not exists updated_at timestamptz not null default now();
create or replace function public.trg_vacation_weekly_off_policies_updated_at_fn()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_vacation_weekly_off_policies_updated_at
  on public.v2_vacation_weekly_off_policies;
create trigger trg_vacation_weekly_off_policies_updated_at
  before update on public.v2_vacation_weekly_off_policies
  for each row execute function public.trg_vacation_weekly_off_policies_updated_at_fn();
notify pgrst, 'reload schema';
