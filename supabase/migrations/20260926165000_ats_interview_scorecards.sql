-- ats_interview_scorecards
--
-- WHAT THIS CHANGES: one NEW table — ats_interview_scorecards — the interviewers' evaluation of a
--   candidate. One row per (interview booking, evaluator): an overall rating 1–5 and a verdict
--   (strong_yes / yes / no), plus an optional short comment. Every person ON the interview (the lead
--   and each panel member) files their OWN; they are shown side by side.
--
-- WHY: the owner, 2026-09-26 (Tier 2) — turn the interview calendar into an evaluation tool. This
--   COMPLEMENTS the interview outcome (attended / shortlisted / rejected …), which still moves the
--   candidate in Recruitment; the scorecard is the panel's opinion, not a lifecycle action, so it
--   moves nothing on its own.
--
-- ROLLBACK:
--   drop table public.ats_interview_scorecards;
--   Nothing below deletes or rewrites an existing row — it only adds a new, empty table.
--
-- Service-role only: RLS on, no policy, nothing granted to anon or authenticated — the same shape as
-- the other ats_interview_* tables. Reads and writes go through the service-role client after an
-- app-level check (only an evaluator on the interview may file, and only their own row).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This is
-- additive and non-destructive: a new empty table only.

begin;

create table if not exists public.ats_interview_scorecards (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ats_interview_bookings(id) on delete cascade,
  evaluator_hr_id text not null,
  rating integer not null,
  verdict text not null,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ats_interview_scorecards_rating_range check (rating between 1 and 5),
  constraint ats_interview_scorecards_verdict_valid check (verdict in ('strong_yes', 'yes', 'no')),
  constraint ats_interview_scorecards_one_per_evaluator unique (booking_id, evaluator_hr_id)
);

create index if not exists ats_interview_scorecards_booking_idx on public.ats_interview_scorecards (booking_id);

comment on table public.ats_interview_scorecards is
  'One interviewer''s evaluation of a candidate for one interview: rating 1-5 + verdict (strong_yes/yes/no) + optional comment. Complements the interview outcome; moves nothing on its own.';

alter table public.ats_interview_scorecards enable row level security;

revoke all on table public.ats_interview_scorecards from anon, authenticated;

grant all on table public.ats_interview_scorecards to service_role;

commit;
