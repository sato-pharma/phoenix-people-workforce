-- ats_interview_calendar
--
-- WHAT THIS CHANGES: three new tables, nothing existing is touched.
--   * ats_interview_bookings          — one interview booked against a CV: when, how long, in the
--                                       office or on Zoom, and the Zoom meeting Phoenix created.
--   * ats_interview_calendar_shares   — who the owner shared the interview calendar with, and as
--                                       what: viewer, commenter or editor.
--   * ats_interview_booking_comments  — the notes commenters and editors leave on one interview.
--
-- WHY: the owner, 2026-09-18 — book an interview from ANY CV, on any screen, without the pipeline's
-- steps; see the week as a calendar (Sunday to Thursday, 9:00 AM to 5:00 PM, half-hour rows); export
-- it as PDF or Excel with every candidate's name opening their CV; and share it from Phoenix with
-- viewer / commenter / editor access. He chose, in chat: nothing is sent to the candidate, only he and
-- the people he shares with can see it, and Phoenix creates the Zoom meeting itself.
--
-- WHY A BOOKING IS NOT AN ats_interviews ROW. ats_interviews hangs off an APPLICATION (a candidate
-- against a requisition), and its create path emails the candidate. Almost no CV on record has an
-- application, and the owner asked for exactly the opposite of both: any CV, no steps, nothing sent.
-- A booking hangs off the CANDIDATE directly.
--
-- ROLLBACK:
--   drop table if exists public.ats_interview_booking_comments;
--   drop table if exists public.ats_interview_bookings;
--   drop table if exists public.ats_interview_calendar_shares;
-- (Loses every booking, share and comment made since. Nothing else reads these tables.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- ---------------------------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_interview_bookings (
  id uuid primary key default gen_random_uuid(),
  -- CASCADE: an interview with nobody attached to it is not an interview. A merged or deleted CV
  -- takes its bookings with it rather than leaving a nameless slot on the calendar.
  candidate_id uuid not null references public.ats_candidates (id) on delete cascade,
  starts_at timestamptz not null,
  duration_minutes integer not null default 30,
  platform text not null,
  -- What happened to the Zoom meeting, so the screen can say it instead of guessing:
  --   not_needed    — an office interview
  --   created       — Phoenix created it; zoom_meeting_id and zoom_join_url are filled
  --   not_connected — Zoom booking, but Phoenix has no Zoom account connected yet
  --   failed        — Zoom refused; zoom_error says why, and the booking still stands
  zoom_status text not null default 'not_needed',
  zoom_meeting_id text,
  zoom_join_url text,
  zoom_error text,
  notes text,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ats_interview_bookings_platform_valid check (platform in ('in_office', 'zoom')),
  constraint ats_interview_bookings_zoom_status_valid
    check (zoom_status in ('not_needed', 'created', 'not_connected', 'failed')),
  -- An office interview never carries a meeting; the screen would otherwise show a Zoom link on it.
  constraint ats_interview_bookings_office_has_no_meeting
    check (platform = 'zoom' or (zoom_status = 'not_needed' and zoom_meeting_id is null and zoom_join_url is null)),
  constraint ats_interview_bookings_duration_valid
    check (duration_minutes between 15 and 240 and duration_minutes % 15 = 0),
  constraint ats_interview_bookings_notes_length check (notes is null or length(notes) <= 1000)
);

comment on table public.ats_interview_bookings is
  'Interviews booked from a CV onto the interview calendar. Hangs off the candidate, not an application; nothing is sent to the candidate.';
comment on column public.ats_interview_bookings.zoom_status is
  'not_needed (office) | created | not_connected (no Zoom account connected) | failed (see zoom_error).';

create index if not exists ats_interview_bookings_starts_at_idx
  on public.ats_interview_bookings (starts_at);
create index if not exists ats_interview_bookings_candidate_idx
  on public.ats_interview_bookings (candidate_id, starts_at);

-- ---------------------------------------------------------------------------------------------
-- Shares
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_interview_calendar_shares (
  hr_id text primary key,
  access_level text not null,
  shared_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ats_interview_calendar_shares_level_valid
    check (access_level in ('viewer', 'commenter', 'editor')),
  constraint ats_interview_calendar_shares_hr_id_not_blank check (length(btrim(hr_id)) > 0)
);

-- HR ids are stored in mixed case across this database. Without this, "B-10" and "b-10" would be
-- two shares for one person, each with its own access level, and which one wins would depend on
-- the order the rows came back in.
create unique index if not exists ats_interview_calendar_shares_hr_id_ci_idx
  on public.ats_interview_calendar_shares (lower(btrim(hr_id)));

comment on table public.ats_interview_calendar_shares is
  'Who the owner shared the interview calendar with. viewer sees it and opens CVs; commenter also comments; editor also books, moves and cancels.';

-- ---------------------------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_interview_booking_comments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ats_interview_bookings (id) on delete cascade,
  author_hr_id text not null,
  body text not null,
  created_at timestamptz not null default now(),

  constraint ats_interview_booking_comments_body_not_blank check (length(btrim(body)) > 0),
  constraint ats_interview_booking_comments_body_length check (length(body) <= 1000)
);

create index if not exists ats_interview_booking_comments_booking_idx
  on public.ats_interview_booking_comments (booking_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Access: service role only.
--
-- Deliberately NO grant to anon or authenticated. Visibility in this app is application-scoped:
-- every read and write goes through the service-role client after the share check in
-- src/lib/recruitment/interview-calendar.ts, and these rows name candidates.
-- ---------------------------------------------------------------------------------------------

alter table public.ats_interview_bookings enable row level security;
alter table public.ats_interview_calendar_shares enable row level security;
alter table public.ats_interview_booking_comments enable row level security;

revoke all on table public.ats_interview_bookings from anon, authenticated;
revoke all on table public.ats_interview_calendar_shares from anon, authenticated;
revoke all on table public.ats_interview_booking_comments from anon, authenticated;

grant all on table public.ats_interview_bookings to service_role;
grant all on table public.ats_interview_calendar_shares to service_role;
grant all on table public.ats_interview_booking_comments to service_role;

commit;
