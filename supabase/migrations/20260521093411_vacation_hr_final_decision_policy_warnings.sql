-- Vacation HR final decision and policy warning support.
-- Additive-only for the new v2 vacation module. Does not touch old leave objects.

begin;

alter table public.v2_vacation_requests
  add column if not exists hr_decision text null,
  add column if not exists hr_decision_by_hr_id text null,
  add column if not exists hr_decision_at timestamptz null,
  add column if not exists hr_decision_comment text null;

alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_status_check,
  add constraint v2_vacation_requests_status_check
    check (status in ('pending_manager', 'pending_hr', 'approved', 'rejected'));

alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_hr_decision_check,
  add constraint v2_vacation_requests_hr_decision_check
    check (hr_decision is null or hr_decision in ('approved', 'rejected'));

create index if not exists v2_vacation_requests_hr_final_review_idx
  on public.v2_vacation_requests (status, hr_decision_at desc)
  where status = 'pending_hr';

notify pgrst, 'reload schema';

commit;
