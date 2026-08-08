-- Add "Meeting with Team" as a valid weekly/monthly plan activity type.
-- Distinct from generic "Meeting" (which may be external and need a location) --
-- an internal team meeting, no geography required (see noGeographyActivities
-- in plans-workspace.tsx).

ALTER TABLE public.employee_plan_items
  DROP CONSTRAINT employee_plan_items_activity_type_check;

ALTER TABLE public.employee_plan_items
  ADD CONSTRAINT employee_plan_items_activity_type_check
  CHECK ((activity_type = ANY (ARRAY[
    'Office'::text,
    'Field'::text,
    'Double Visit'::text,
    'Training'::text,
    'Meeting'::text,
    'Meeting with Team'::text,
    'Event'::text,
    'Travel'::text,
    'Admin'::text,
    'Remote'::text,
    'Vacation'::text,
    'National Vacation'::text,
    'Excuse'::text,
    'Other'::text
  ])));
