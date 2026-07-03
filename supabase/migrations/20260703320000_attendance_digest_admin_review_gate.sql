-- Admin review gate before a deduction-bearing digest reaches an employee.
--
-- Owner directive (2026-07-03): a digest with a real deduction must never go
-- straight to the employee. It routes to the System Administrator /
-- HR Manager approver list first (attendance_digest_settings.approver_hr_ids
-- — either may act, first to act wins, same pattern as dispute review). They
-- can edit any line's deduction_days/deduction_value/reason before approving.
-- Only on approval does the (possibly edited) digest actually send, entering
-- the normal confirm/dispute/48h-auto-confirm flow. A clean (zero-deduction)
-- digest is unaffected and still sends immediately.
--
-- New lifecycle: draft -> pending_admin_review -> sent -> settled/auto_confirmed/void
-- (clean digests skip pending_admin_review entirely: draft -> sent -> ...)

begin;

alter table public.attendance_weekly_digests
  drop constraint if exists attendance_weekly_digests_status_check;

alter table public.attendance_weekly_digests
  add constraint attendance_weekly_digests_status_check
  check (status in ('draft', 'pending_admin_review', 'sent', 'settled', 'auto_confirmed', 'void'));

alter table public.attendance_weekly_digests
  add column if not exists reviewed_by text null,
  add column if not exists reviewed_at timestamptz null;

comment on column public.attendance_weekly_digests.reviewed_by is
  'HR_ID of the approver (attendance_digest_settings.approver_hr_ids) who approved a pending_admin_review digest, sending it (with any edits) to the employee.';
comment on column public.attendance_weekly_digests.reviewed_at is
  'When the admin review approval happened. Null for digests that skipped review (clean weeks) or are still pending.';

-- Audit snapshot of the system-computed value before any admin edit. Null
-- means the line was never edited (deduction_days/deduction_value/reason on
-- the line itself are still the original, system-computed values).
alter table public.attendance_digest_lines
  add column if not exists original_deduction_days numeric(8,3) null,
  add column if not exists original_deduction_value numeric(12,2) null,
  add column if not exists original_reason text null;

comment on column public.attendance_digest_lines.original_deduction_days is
  'System-computed deduction_days before an admin edit, for audit/diff display. Null = never edited.';
comment on column public.attendance_digest_lines.original_deduction_value is
  'System-computed deduction_value before an admin edit, for audit/diff display. Null = never edited.';
comment on column public.attendance_digest_lines.original_reason is
  'System-computed reason before an admin edit, for audit/diff display. Null = never edited.';

create index if not exists attendance_weekly_digests_pending_review_idx
  on public.attendance_weekly_digests (status)
  where status = 'pending_admin_review';

notify pgrst, 'reload schema';

commit;
