-- Field Workforce Compliance: allow the new day-level ignore reasons.
--
-- The employee-driven / weekend-by-title / national-holiday classifier changes made the
-- engine emit `weekly_off` (Friday always; Saturday too unless the title is Medical Rep /
-- District Manager) and `national_holiday`, in addition to `before_hiring_date`. The old
-- CHECK constraint only allowed `before_hiring_date` and `friday`, so archiving any month
-- that contains a national holiday or a non-Medical-Rep weekend failed with
-- "field_workforce_days_ignore_reason_check" violation.
--
-- This relaxes the constraint to allow the new values. It is additive (no data change);
-- `friday` is kept for backward compatibility with any previously archived rows.

alter table public.field_workforce_compliance_days
  drop constraint if exists field_workforce_days_ignore_reason_check;

alter table public.field_workforce_compliance_days
  add constraint field_workforce_days_ignore_reason_check
  check (
    ignore_reason is null
    or ignore_reason = any (array['before_hiring_date', 'friday', 'weekly_off', 'national_holiday'])
  );
