-- Weekly-digest reviewer transparency: store the raw check-in/check-out
-- clock time (minutes since local midnight) on each digest line, alongside
-- the already-stored derived late/short/worked minutes. A reviewer judging
-- whether to edit or approve a deduction needs the actual punch times, not
-- just the derived numbers. Nullable — a missing-punch day has no check-out,
-- and older rows predating this column simply have both null.
alter table public.attendance_digest_lines
  add column if not exists check_in_minutes integer null,
  add column if not exists check_out_minutes integer null;

comment on column public.attendance_digest_lines.check_in_minutes is
  'First punch of the day, minutes since local midnight. Null if no punch.';
comment on column public.attendance_digest_lines.check_out_minutes is
  'Last punch of the day, minutes since local midnight. Null if only one punch (missing-punch case) or no punch.';
