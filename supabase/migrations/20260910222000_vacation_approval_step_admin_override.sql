-- Stalled-approver override for vacation approvals (owner instruction, 2026-09-10).
--
-- A Super Admin may decide an active MANAGEMENT approval step once its approver has held it for
-- ADMIN_OVERRIDE_STALL_DAYS (2 flat calendar days). The step row keeps `approver_hr_id` pointing
-- at the assigned approver, because that is genuinely whose step it was — so without these two
-- columns a decided row would be indistinguishable from that person having answered it. These
-- exist so the override is a fact on the row, not a string to be parsed out of decision_comment.
--
-- Additive and nullable: every existing row stays NULL, which reads as "decided normally".

alter table public.v2_vacation_approval_steps
  add column if not exists overridden_by_hr_id text,
  add column if not exists overridden_at timestamptz;

comment on column public.v2_vacation_approval_steps.overridden_by_hr_id is
  'Super Admin who decided this step in the assigned approver''s place after the 2-day stall. NULL means the assigned approver decided it themselves.';

comment on column public.v2_vacation_approval_steps.overridden_at is
  'When the override was recorded. Always NULL when overridden_by_hr_id is NULL.';

-- Partial index: overrides are rare, so this stays tiny while making "show me every overridden
-- step" answerable without a sequential scan of the whole table.
create index if not exists v2_vacation_approval_steps_overridden_idx
  on public.v2_vacation_approval_steps (overridden_by_hr_id, overridden_at desc)
  where overridden_by_hr_id is not null;
