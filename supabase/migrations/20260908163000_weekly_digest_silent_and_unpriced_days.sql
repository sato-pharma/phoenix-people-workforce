-- Weekly attendance digest — two owner decisions, both taken 2026-09-08 after the
-- module was applied and enabled for two minutes, then stopped.
--
-- 1. PERMANENTLY SILENT. "never send anyone anything". The digest notifies nobody —
--    not the employee, not a reviewer, in any channel. It is a PAGE somebody visits.
--
--    That removes the 48-hour auto-confirm with it. A window can only run against
--    someone who was told it had started; with no notice there is no window, so an
--    unanswered day stays unanswered, writes no settlement, and reaches the owner in
--    the month-end Deductions queue as Pending exactly as it does today. The channel
--    and auto-confirm columns go, and so do the `sent` status and the `auto_confirmed`
--    action — leaving them would let a later edit switch sending back on by filling in
--    a column rather than by deciding to.
--
-- 2. AN UNPRICED DAY IS NOT A FREE DAY. The report returns the literal string
--    "Base salary missing" when an employee has no salary on file, and the first
--    version coerced that to 0. The 2026-09-08 dry run showed B-185 would have been
--    told "2 days, 0.00 EGP" for two days that then become real month-end candidates.
--    `deduction_value` becomes NULLABLE, NULL meaning "chargeable but not priced", and
--    a week containing one keeps NULL as its total rather than a partial sum that
--    looks complete.
--
-- Safe as written: both tables are empty in production and staging (verified before
-- applying — 0 digests, 0 lines, 0 settlements), so no row has to be migrated.

begin;

-- ---------------------------------------------------------------------------
-- 1. Silence
-- ---------------------------------------------------------------------------
alter table public.attendance_digest_settings drop column if exists channel_in_app;
alter table public.attendance_digest_settings drop column if exists channel_telegram;
alter table public.attendance_digest_settings drop column if exists channel_email;
alter table public.attendance_digest_settings drop column if exists auto_confirm_hours;
alter table public.attendance_digest_settings drop column if exists cc_manager;
alter table public.attendance_digest_settings drop column if exists cc_ceo;

alter table public.attendance_weekly_digests drop column if exists sent_at;
alter table public.attendance_weekly_digests drop column if exists auto_confirm_at;
alter table public.attendance_weekly_digests drop column if exists channels;
drop index if exists attendance_weekly_digests_auto_confirm_idx;

-- A digest is open the moment it is generated: there is no send step to wait for.
alter table public.attendance_weekly_digests drop constraint if exists attendance_weekly_digests_status_check;
alter table public.attendance_weekly_digests alter column status set default 'open';
alter table public.attendance_weekly_digests
  add constraint attendance_weekly_digests_status_check
  check (status in ('open', 'settled', 'void'));

alter table public.attendance_digest_lines drop constraint if exists attendance_digest_lines_action_check;
alter table public.attendance_digest_lines
  add constraint attendance_digest_lines_action_check
  check (action in ('pending', 'confirmed', 'disputed'));

alter table public.attendance_settlements drop constraint if exists attendance_settlements_action_check;
alter table public.attendance_settlements
  add constraint attendance_settlements_action_check
  check (action in ('confirmed', 'dispute_upheld', 'dispute_rejected'));

-- The double-answer guard named auto_confirmed, so it has to be rebuilt without it.
drop index if exists attendance_settlements_no_double_deduction_idx;
create unique index if not exists attendance_settlements_no_double_deduction_idx
  on public.attendance_settlements (employee_hr_id, work_date)
  where action in ('confirmed', 'dispute_rejected');

-- ---------------------------------------------------------------------------
-- 2. Unpriced days
-- ---------------------------------------------------------------------------
alter table public.attendance_digest_lines alter column deduction_value drop not null;
alter table public.attendance_digest_lines alter column deduction_value drop default;

alter table public.attendance_weekly_digests alter column total_deduction_value drop not null;
alter table public.attendance_weekly_digests alter column total_deduction_value drop default;
alter table public.attendance_weekly_digests
  add column if not exists has_unpriced_day boolean not null default false;

alter table public.attendance_settlements alter column deduction_value drop not null;
alter table public.attendance_settlements alter column deduction_value drop default;

comment on column public.attendance_digest_lines.deduction_value is
  'NULL means the day is chargeable but could not be priced (no salary on file) — never that it is free.';
comment on column public.attendance_weekly_digests.total_deduction_value is
  'NULL when any day in the week is unpriced. Deliberately not a partial sum, which would look complete.';
comment on column public.attendance_weekly_digests.has_unpriced_day is
  'True when at least one line has no price, so a reader can tell a NULL total from a total nobody computed.';

notify pgrst, 'reload schema';

commit;
