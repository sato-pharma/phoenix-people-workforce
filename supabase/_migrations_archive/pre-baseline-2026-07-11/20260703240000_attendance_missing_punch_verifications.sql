-- Missing-punch verification chain.
--
-- A missing-punch digest line (only one punch that day) carries zero EGP
-- deduction and never enters the confirm/dispute settlement flow — it needs a
-- documented reason with proof, verified sequentially by three people:
--   1. The standing verifier (attendance_digest_settings.missing_punch_verifier_hr_id,
--      "A-13" per the confirmed spec) confirms the reason genuinely happened.
--   2. An HR approver (attendance_digest_settings.approver_hr_ids — the same
--      "HR Manager / System Admin" list used for dispute review) confirms.
--   3. The CEO (app_auth_users.role = 'CEO') gives final confirmation.
-- Each step gates strictly on the previous one — unlike dispute review's
-- "either approver, first wins," this chain is sequential by design. Any of
-- the three may reject at their step, which ends the chain.

begin;

create table if not exists public.attendance_missing_punch_verifications (
  id                  bigserial primary key,
  digest_line_id      bigint      not null unique references public.attendance_digest_lines(id) on delete cascade,
  employee_hr_id      text        not null,
  work_date           date        not null,
  employee_reason     text        null,
  employee_proof_url  text        null,
  submitted_at        timestamptz null,
  verifier_hr_id      text        null,
  verifier_confirmed_at timestamptz null,
  hr_hr_id            text        null,
  hr_confirmed_at     timestamptz null,
  ceo_hr_id           text        null,
  ceo_confirmed_at    timestamptz null,
  status              text        not null default 'awaiting_employee'
                       check (status in ('awaiting_employee', 'awaiting_verifier', 'awaiting_hr', 'awaiting_ceo', 'fully_verified', 'rejected')),
  rejected_by         text        null,
  rejected_at         timestamptz null,
  rejected_at_step     text       null check (rejected_at_step is null or rejected_at_step in ('verifier', 'hr', 'ceo')),
  rejection_reason    text        null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists attendance_missing_punch_verifications_employee_idx
  on public.attendance_missing_punch_verifications (employee_hr_id, work_date);
create index if not exists attendance_missing_punch_verifications_pending_idx
  on public.attendance_missing_punch_verifications (status)
  where status in ('awaiting_verifier', 'awaiting_hr', 'awaiting_ceo');

alter table public.attendance_missing_punch_verifications enable row level security;
revoke all on table public.attendance_missing_punch_verifications from anon, authenticated;
grant select, insert, update on table public.attendance_missing_punch_verifications to service_role;
grant usage, select on sequence public.attendance_missing_punch_verifications_id_seq to service_role;

drop policy if exists attendance_missing_punch_verifications_service_role_all on public.attendance_missing_punch_verifications;
create policy attendance_missing_punch_verifications_service_role_all on public.attendance_missing_punch_verifications
  for all to service_role using (true) with check (true);

comment on table public.attendance_missing_punch_verifications is
  'Sequential 3-step sign-off (standing verifier -> HR approver -> CEO) for a missing-punch digest line. Zero EGP impact — informational/compliance only, never a deduction.';

notify pgrst, 'reload schema';

commit;
