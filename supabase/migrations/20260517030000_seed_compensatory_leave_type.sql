-- Add missing Compensatory Leave catalog entry used by leave workflows.
-- This backfills an active leave type row expected by the leave requests flow.

INSERT INTO public.leave_types (
  code,
  name,
  is_paid,
  affects_payroll,
  requires_attachment,
  requires_manager_approval,
  requires_hr_approval,
  is_active,
  employee_selectable
)
SELECT
  'compensatory_leave',
  'Compensatory Leave',
  true,
  false,
  false,
  true,
  true,
  true,
  true
WHERE NOT EXISTS (
  SELECT 1
  FROM public.leave_types
  WHERE code = 'compensatory_leave'
);
