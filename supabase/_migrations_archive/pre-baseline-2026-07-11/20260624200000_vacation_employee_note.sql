-- Add optional employee_note column to vacation requests.
-- The existing `notes` column is reserved for the required "other" reason.
-- This new column holds a freeform note the employee can optionally include
-- with any vacation type at submission time.
alter table public.v2_vacation_requests
  add column if not exists employee_note text;
