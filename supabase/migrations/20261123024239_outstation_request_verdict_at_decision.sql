-- outstation_request_verdict_at_decision
--
-- WHAT THIS CHANGES: two nullable columns on public.outstation_expense_requests.
--   system_lane_at_decision     the lane the system had filed the claim in when it was decided —
--                               'ready' (every check passed) or 'your_call' (something was unclear).
--   system_verdict_at_decision  the checks as they stood at that moment, the decision taken on them
--                               (approve / reduce / reject), the figures and the time, as jsonb.
-- WHY: until now a decision WROTE OVER the system's own reading of the claim (status and
--   approval_reason are replaced by the accept and reject paths), so nobody could ask afterwards
--   "how often is the system right?". Measured on production 2026-11-23: a claim the system called
--   matched was rejected 24% of the time, one it called no activity 26% — a reading that says nothing,
--   and no stored record to learn from. Expense Approvals (rebuilt 2026-11-23, owner: "rebuild from
--   scratch") stamps these when the Super Admin decides, and its 30-day agreement meter reads them.
--   Nothing is backfilled: the past was decided on checks nobody kept, and inventing them would be a lie.
--   No money column, no status and no row is touched.
-- ROLLBACK:
--   alter table public.outstation_expense_requests
--     drop constraint if exists outstation_expense_requests_system_lane_at_decision_check,
--     drop column if exists system_lane_at_decision,
--     drop column if exists system_verdict_at_decision;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.outstation_expense_requests
  add column if not exists system_lane_at_decision text,
  add column if not exists system_verdict_at_decision jsonb;

alter table public.outstation_expense_requests
  drop constraint if exists outstation_expense_requests_system_lane_at_decision_check;

-- "is null or …" is written out: a CHECK refuses only FALSE, and the undecided claim is the common row.
alter table public.outstation_expense_requests
  add constraint outstation_expense_requests_system_lane_at_decision_check
  check (system_lane_at_decision is null or system_lane_at_decision in ('ready', 'your_call'));

comment on column public.outstation_expense_requests.system_lane_at_decision is
  'The lane Expense Approvals had filed this claim in when the Super Admin decided it: ready or your_call. Null until decided on the rebuilt page (2026-11-23).';
comment on column public.outstation_expense_requests.system_verdict_at_decision is
  'The system''s checks as they stood at the decision, with the action taken, the figures and the time. Read by the 30-day agreement meter; never by a pay rule.';

commit;
