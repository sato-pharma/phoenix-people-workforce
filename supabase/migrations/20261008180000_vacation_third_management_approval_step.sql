-- Vacation approval chain: allow a THIRD management step (owner rule, 2026-10-08).
--
-- A Medical Rep who reports District Manager -> Regional Manager -> National Sales Manager needs
-- the NSM as a third management approver before HR acknowledges. The steps table only knew
-- direct_manager / manager_of_manager / hr, so the chain stopped at the Regional Manager.
--
-- Widening a CHECK only: no row changes, existing steps stay valid, re-applying is a no-op.

alter table public.v2_vacation_approval_steps
  drop constraint if exists v2_vacation_approval_steps_step_key_check;

alter table public.v2_vacation_approval_steps
  add constraint v2_vacation_approval_steps_step_key_check
  check (step_key = any (array['direct_manager'::text, 'manager_of_manager'::text, 'manager_level_3'::text, 'hr'::text]));
