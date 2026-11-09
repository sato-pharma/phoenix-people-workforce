-- deductions_decision_comment_optional
--
-- WHAT THIS CHANGES: drops the CHECK on public.deductions_decisions that refused a decided row
--   (anything but Pending) with an empty decision_reason. The column itself is unchanged
--   (text not null default '') — a decision with no comment is stored as ''.
-- WHY: the owner, 2026-11-09 — "in deductions module make comment for decision optional". The
--   server-side check in recordDecision (src/lib/deductions/service.ts) is removed in the same PR;
--   without this the database would still refuse the blank decision.
--   The constraint was created as deductions_decisions_reason_required_when_decided
--   (20260725115137_deductions_module.sql) but the baseline dump spells it
--   deduction_decisions_reason_required_when_decided, so both names are dropped.
-- ROLLBACK: alter table public.deductions_decisions
--     add constraint deductions_decisions_reason_required_when_decided
--     check (decision_status = 'Pending' or btrim(decision_reason) <> '') not valid;
--   (NOT VALID, because blank decided rows saved after this change would fail a validating add.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This touches no row: it only removes a rule. Nothing to back up.

begin;

alter table public.deductions_decisions
  drop constraint if exists deductions_decisions_reason_required_when_decided;

alter table public.deductions_decisions
  drop constraint if exists deduction_decisions_reason_required_when_decided;

commit;
