-- Wrong-week guard: flag a weekly plan filed for a week that had already begun or fully elapsed at
-- the moment it was created — an "off-window" plan.
--
-- Context (owner, 2026-09-26): people were submitting weekly plans in the wrong week because the
-- Plan-week dropdown auto-selected a week for them. The builder now starts with the week UNCHOSEN,
-- marks already-planned weeks green, and — when someone deliberately picks a past week — asks once
-- and records this flag. It is a MARKER, never a block: the plan is created normally so the owner
-- and reviewers can simply see which plans were filed off-window.
--
-- Set once at creation (see createEmployeePlan + isPastPlanWeek); a plan filed on time never becomes
-- off-window later. Additive and non-destructive: defaults false, so every existing plan reads
-- on-window unchanged.
alter table public.employee_plan_headers
  add column if not exists off_window_flagged boolean not null default false;

comment on column public.employee_plan_headers.off_window_flagged is
  'True when this weekly plan was created for a week that had already begun or fully elapsed (isPastPlanWeek). Set once at creation; a review marker only, never enforced.';
