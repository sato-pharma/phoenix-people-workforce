-- Add 'short_hours' as an allowed deduction_candidates.deduction_type.
--
-- The flexible-hours weekly-digest settlement (attendance-settlement-service)
-- produces a distinct "worked fewer than the required minutes" violation that
-- is not the same measurement as 'early_leave' (minutes before a FIXED
-- scheduled_end) — see the matching widening of
-- attendance_policy_rules_event_type_check in migration 20260703200000.
-- Reusing 'early_leave' here would mislabel every flexible-hours short-hours
-- settlement in governance reporting. Purely additive: no existing row or
-- value is affected.

begin;

alter table public.deduction_candidates
  drop constraint if exists deduction_candidates_deduction_type_check;

alter table public.deduction_candidates
  add constraint deduction_candidates_deduction_type_check check (deduction_type in (
    'no_activity',
    'absence',
    'late_arrival',
    'early_leave',
    'short_hours',
    'missing_punch',
    'unpaid_leave',
    'leave_without_balance',
    'retroactive_leave',
    'disciplinary_deduction',
    'manual_deduction',
    'expense_recovery',
    'salary_adjustment',
    'other'
  ));

notify pgrst, 'reload schema';

commit;
