-- ats_mr_hiring_workflow
--
-- WHAT THIS CHANGES: the Medical Rep hiring workflow the owner announced to the managers, effective
-- Sunday 8 November 2026 (docs/recruitment-mr-hiring-workflow.md).
--   1. ats_interview_bookings gains `interview_round` (which of the five rounds an interview is:
--      HR 1st, DSM 2nd, HR Manager 3rd, NSM final, or the joint HR Manager + NSM final) and
--      `location` (where an in-person interview is held — "date, time and location must be
--      registered in the system", §5). Both nullable: every existing booking keeps NULL and reads
--      exactly as before.
--   2. ats_mr_hiring_step_results — one row per result recorded at a step (HR screening, each
--      interview, the final decision): Pass / Keep as backup / Do not pass, with the comment the
--      email asks for "on the candidate's CV", and a flag when HR decided because the DSM gave no
--      feedback (§6). Append-only: the newest row per (candidate, step) is the answer.
--   3. ats_mr_hiring_recommendations — the NSM's final recommendation (§8): make an offer or keep as
--      backup, the proposed salary and the proposed joining date. Its own table so the salary is
--      read in one place and can be gated in one place. Append-only.
-- WHY: the system must follow the email's steps exactly; the rounds, the location, the DSM's
--   feedback, the NSM's recommendation and the final decision had nowhere to be written.
-- ROLLBACK:
--   drop table if exists public.ats_mr_hiring_recommendations;  -- SAFE: rollback only
--   drop table if exists public.ats_mr_hiring_step_results;     -- SAFE: rollback only
--   drop function if exists public.phx_ats_mr_hiring_append_only();
--   alter table public.ats_interview_bookings drop column if exists location, drop column if exists interview_round;
--   (the rollback loses every result and recommendation recorded since — take a copy first)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: two nullable columns and two new empty tables.

begin;

-- ── 1. the round and the place on a booking ──────────────────────────────────────────────────

alter table public.ats_interview_bookings
  add column if not exists interview_round text,
  add column if not exists location text;

alter table public.ats_interview_bookings drop constraint if exists ats_interview_bookings_round_known;
alter table public.ats_interview_bookings
  add constraint ats_interview_bookings_round_known
  check (interview_round is null or interview_round in ('hr_first', 'dsm', 'hr_manager', 'nsm_final', 'joint_final'));

alter table public.ats_interview_bookings drop constraint if exists ats_interview_bookings_location_length;
alter table public.ats_interview_bookings
  add constraint ats_interview_bookings_location_length
  check (location is null or char_length(location) <= 300);

create index if not exists ats_interview_bookings_candidate_round_idx
  on public.ats_interview_bookings (candidate_id, interview_round)
  where interview_round is not null;

-- ── 2. the results recorded at each step ─────────────────────────────────────────────────────

create table if not exists public.ats_mr_hiring_step_results (
  id bigint generated always as identity primary key,
  candidate_id uuid not null references public.ats_candidates (id) on delete cascade,
  booking_id uuid references public.ats_interview_bookings (id) on delete set null,
  step text not null,
  result text not null,
  rating smallint,
  comment text not null,
  decided_without_dsm boolean not null default false,
  by_hr_id text not null,
  created_at timestamptz not null default now(),
  constraint ats_mr_hiring_step_results_step_known
    check (step in ('hr_screening', 'hr_first', 'dsm', 'hr_manager', 'nsm_final', 'joint_final', 'final_decision')),
  constraint ats_mr_hiring_step_results_result_known
    check (result in ('pass', 'backup', 'not_pass')),
  constraint ats_mr_hiring_step_results_rating_range
    check (rating is null or rating between 1 and 5),
  constraint ats_mr_hiring_step_results_comment_present
    check (char_length(btrim(comment)) between 1 and 2000),
  constraint ats_mr_hiring_step_results_no_dsm_only_on_dsm
    check (decided_without_dsm = false or step = 'dsm')
);

create index if not exists ats_mr_hiring_step_results_candidate_idx
  on public.ats_mr_hiring_step_results (candidate_id, created_at desc);

alter table public.ats_mr_hiring_step_results enable row level security;
drop policy if exists phx_ats_mr_hiring_step_results_service_role on public.ats_mr_hiring_step_results;
create policy phx_ats_mr_hiring_step_results_service_role
  on public.ats_mr_hiring_step_results
  to service_role using (true) with check (true);
revoke all on table public.ats_mr_hiring_step_results from anon, authenticated;
grant all on table public.ats_mr_hiring_step_results to service_role;

-- ── 3. the NSM's recommendation ──────────────────────────────────────────────────────────────

create table if not exists public.ats_mr_hiring_recommendations (
  id bigint generated always as identity primary key,
  candidate_id uuid not null references public.ats_candidates (id) on delete cascade,
  booking_id uuid references public.ats_interview_bookings (id) on delete set null,
  recommendation text not null,
  proposed_salary numeric(12, 2),
  proposed_joining_date date,
  note text,
  by_hr_id text not null,
  created_at timestamptz not null default now(),
  constraint ats_mr_hiring_recommendations_known
    check (recommendation in ('make_offer', 'keep_backup')),
  constraint ats_mr_hiring_recommendations_offer_complete
    check (recommendation <> 'make_offer' or (proposed_salary is not null and proposed_salary > 0 and proposed_joining_date is not null)),
  constraint ats_mr_hiring_recommendations_salary_positive
    check (proposed_salary is null or proposed_salary > 0),
  constraint ats_mr_hiring_recommendations_note_length
    check (note is null or char_length(note) <= 2000)
);

create index if not exists ats_mr_hiring_recommendations_candidate_idx
  on public.ats_mr_hiring_recommendations (candidate_id, created_at desc);

alter table public.ats_mr_hiring_recommendations enable row level security;
drop policy if exists phx_ats_mr_hiring_recommendations_service_role on public.ats_mr_hiring_recommendations;
create policy phx_ats_mr_hiring_recommendations_service_role
  on public.ats_mr_hiring_recommendations
  to service_role using (true) with check (true);
revoke all on table public.ats_mr_hiring_recommendations from anon, authenticated;
grant all on table public.ats_mr_hiring_recommendations to service_role;

-- ── 4. append-only, both tables ──────────────────────────────────────────────────────────────
-- A recorded result is evidence about a real applicant: a changed mind is a NEW row, never an edit.
-- UPDATE and DELETE are refused per row, and TRUNCATE needs its own statement-level trigger
-- (20260815210000 explains why). Two referential actions must still work, because the calendar
-- deletes bookings (interview-calendar.ts) and a candidate can be deleted:
--   * ats_candidates ON DELETE CASCADE deletes the candidate's rows;
--   * ats_interview_bookings ON DELETE SET NULL updates booking_id to null and NOTHING else.
-- Both arrive from the foreign key's own trigger, so they run at trigger depth > 1; a direct
-- statement runs at depth 1. Only those two exact shapes pass — any other change is refused.

create or replace function public.phx_ats_mr_hiring_append_only()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if tg_op = 'UPDATE'
       and old.booking_id is not null
       and new.booking_id is null
       and (to_jsonb(new) - 'booking_id') = (to_jsonb(old) - 'booking_id') then
      return new;
    end if;
  end if;
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

revoke execute on function public.phx_ats_mr_hiring_append_only() from public, anon, authenticated;
grant execute on function public.phx_ats_mr_hiring_append_only() to service_role;

drop trigger if exists ats_mr_hiring_step_results_append_only on public.ats_mr_hiring_step_results;
create trigger ats_mr_hiring_step_results_append_only
  before update or delete on public.ats_mr_hiring_step_results
  for each row execute function public.phx_ats_mr_hiring_append_only();

drop trigger if exists ats_mr_hiring_step_results_no_truncate on public.ats_mr_hiring_step_results;
create trigger ats_mr_hiring_step_results_no_truncate
  before truncate on public.ats_mr_hiring_step_results
  for each statement execute function public.phx_ats_mr_hiring_append_only();

drop trigger if exists ats_mr_hiring_recommendations_append_only on public.ats_mr_hiring_recommendations;
create trigger ats_mr_hiring_recommendations_append_only
  before update or delete on public.ats_mr_hiring_recommendations
  for each row execute function public.phx_ats_mr_hiring_append_only();

drop trigger if exists ats_mr_hiring_recommendations_no_truncate on public.ats_mr_hiring_recommendations;
create trigger ats_mr_hiring_recommendations_no_truncate
  before truncate on public.ats_mr_hiring_recommendations
  for each statement execute function public.phx_ats_mr_hiring_append_only();

commit;
