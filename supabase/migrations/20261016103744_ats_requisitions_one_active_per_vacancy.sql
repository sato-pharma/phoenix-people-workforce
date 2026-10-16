-- ats_requisitions_one_active_per_vacancy
--
-- WHAT THIS CHANGES: one partial unique index — a vacancy row can carry at most ONE requisition in
--   an active status (draft, open, published, on hold). Requisitions with no vacancy are untouched.
-- WHY: the hourly requisition autopilot (app/api/cron/recruitment-requisition-autopilot) opens a
--   requisition for every empty seat. `createRequisition` checks for an active one first, but a check
--   and an insert are two statements: two runs at once — a retried cron call, or the form beside the
--   autopilot — could both pass the check. The index makes the second insert fail instead.
--   Measured before applying (2026-10-16): 0 vacancy ids carry more than one active requisition.
-- ROLLBACK: drop index if exists public.ats_requisitions_one_active_per_vacancy;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create unique index if not exists ats_requisitions_one_active_per_vacancy
  on public.ats_requisitions (vacancy_id)
  where vacancy_id is not null
    and status in ('req_draft', 'req_open', 'req_published', 'req_on_hold');

commit;
