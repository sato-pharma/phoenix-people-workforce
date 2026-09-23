-- ats_interview_requests
--
-- WHAT THIS CHANGES (additive only — nothing existing is rewritten or dropped):
--   * ats_interview_requests        — one request to interview some CVs on a DAY (no time yet): who
--                                     asked, who will conduct it, which day, and where it stands.
--   * ats_interview_request_items   — one row per CV on a request: a recruitment candidate, or an
--                                     outside person kept on the request only (name/phone/email/CV),
--                                     and the booking it became once HR gave it a time.
--   * ats_interview_bookings.request_id / requested_by_hr_id — the request a booking came from, and
--                                     who asked for it, so the requester sees it on their own calendar.
--
-- WHY: the owner, 2026-09-23 — a District Manager (and above) or HR asks for an interview by choosing
-- a DAY and attaching CVs (uploaded, or picked from Recruitment) and the interviewer (the line's NSM,
-- or the HR head). HR then phones the candidates and gives each CV a real time, which turns the
-- request into booked slots that show on BOTH the requester's and the interviewer's calendar. The
-- two-step "request then time" flow is added BESIDE the existing direct booking — nothing that works
-- today changes. A CV is kept the same way a booking keeps an outside person's CV: the storage
-- adapter's file id, not a Postgres foreign key (the adapter has no delete).
--
-- ROLLBACK:
--   alter table public.ats_interview_bookings drop column if exists request_id;
--   alter table public.ats_interview_bookings drop column if exists requested_by_hr_id;
--   drop table if exists public.ats_interview_request_items;
--   drop table if exists public.ats_interview_requests;
-- (Loses every interview request made since, and the link from a booking back to its request.
--  Nothing else reads these.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This one is additive and touches no existing row.

begin;

-- ---------------------------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_interview_requests (
  id uuid primary key default gen_random_uuid(),
  -- The person who asked for the interview (a District Manager or above, or HR). Stored as written,
  -- compared case-insensitively, exactly like every other HR id on the calendar.
  requested_by_hr_id text not null,
  -- The employee chosen to conduct it (a District Manager or above). Chosen at request time.
  interviewer_hr_id text not null,
  -- The day the requester asked for — a Cairo calendar day, with NO time. HR sets the time later.
  requested_day date not null,
  -- The requester's line/scope at the moment of asking, kept for the HR queue's grouping and display.
  line text,
  note text,
  -- pending    — waiting for HR to give the CVs times
  -- scheduled  — HR has booked at least one of its CVs; the request is served
  -- cancelled  — the requester or HR withdrew it
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ats_interview_requests_status_valid check (status in ('pending', 'scheduled', 'cancelled')),
  constraint ats_interview_requests_requested_by_not_blank check (length(btrim(requested_by_hr_id)) > 0),
  constraint ats_interview_requests_interviewer_not_blank check (length(btrim(interviewer_hr_id)) > 0),
  constraint ats_interview_requests_note_length check (note is null or length(note) <= 1000)
);

comment on table public.ats_interview_requests is
  'A request to interview some CVs on a day (no time yet): who asked, who conducts it, which day, its status. HR turns it into booked slots.';
comment on column public.ats_interview_requests.requested_day is
  'The Cairo calendar day the requester asked for. There is deliberately no time — HR assigns the time when it books each CV.';

create index if not exists ats_interview_requests_day_idx
  on public.ats_interview_requests (requested_day, status);
create index if not exists ats_interview_requests_interviewer_idx
  on public.ats_interview_requests (interviewer_hr_id, requested_day);
create index if not exists ats_interview_requests_requester_idx
  on public.ats_interview_requests (requested_by_hr_id, requested_day);

-- ---------------------------------------------------------------------------------------------
-- Request items — one per CV
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_interview_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.ats_interview_requests (id) on delete cascade,
  -- A recruitment candidate, when the CV was picked from Recruitment. SET NULL rather than CASCADE:
  -- a merged or deleted candidate must not silently drop a CV out of a pending request — HR should
  -- still see it and decide.
  candidate_id uuid references public.ats_candidates (id) on delete set null,
  -- An outside person kept on the request only, mirroring ats_interview_bookings' external_* columns.
  external_name text,
  external_phone text,
  external_email text,
  -- The uploaded CV, kept as the storage adapter's file id (a Drive file id), NOT a Postgres FK —
  -- the same way a booking keeps an outside person's CV (interview-calendar.ts). The adapter has no
  -- delete, so removing the item leaves the stored file with nothing pointing at it.
  external_cv_file_id text,
  external_cv_file_name text,
  external_cv_mime_type text,
  -- The booking this CV became, once HR gave it a time. SET NULL if that booking is later cancelled.
  booking_id uuid references public.ats_interview_bookings (id) on delete set null,
  created_at timestamptz not null default now(),

  -- Every item names a person: a recruitment candidate, or an outside person's name.
  constraint ats_interview_request_items_has_person
    check (candidate_id is not null or length(btrim(coalesce(external_name, ''))) > 0)
);

comment on table public.ats_interview_request_items is
  'One CV on an interview request: a recruitment candidate or an outside person kept here only, and the booking it became once HR gave it a time.';

create index if not exists ats_interview_request_items_request_idx
  on public.ats_interview_request_items (request_id, created_at);
create index if not exists ats_interview_request_items_booking_idx
  on public.ats_interview_request_items (booking_id);
create index if not exists ats_interview_request_items_candidate_idx
  on public.ats_interview_request_items (candidate_id);

-- ---------------------------------------------------------------------------------------------
-- Link a booking back to the request it came from, and to who asked.
-- Additive nullable columns: a booking made directly (the existing path) leaves both NULL.
-- ---------------------------------------------------------------------------------------------

alter table public.ats_interview_bookings
  add column if not exists request_id uuid references public.ats_interview_requests (id) on delete set null;
alter table public.ats_interview_bookings
  add column if not exists requested_by_hr_id text;

comment on column public.ats_interview_bookings.requested_by_hr_id is
  'HR id of the person who requested this interview (a DM-and-above or HR), NULL for a booking made directly. Lets the requester see it on their own calendar; compared case-insensitively.';

create index if not exists ats_interview_bookings_requested_by_idx
  on public.ats_interview_bookings (requested_by_hr_id, starts_at);
create index if not exists ats_interview_bookings_request_idx
  on public.ats_interview_bookings (request_id);

-- ---------------------------------------------------------------------------------------------
-- Access: service role only, exactly like the calendar's other tables. NO grant to anon or
-- authenticated. Every read and write goes through the service-role client after the calendar's
-- own gate in src/lib/recruitment/interview-calendar.ts and interview-requests.ts, and these rows
-- name candidates.
-- ---------------------------------------------------------------------------------------------

alter table public.ats_interview_requests enable row level security;
alter table public.ats_interview_request_items enable row level security;

revoke all on table public.ats_interview_requests from anon, authenticated;
revoke all on table public.ats_interview_request_items from anon, authenticated;

grant all on table public.ats_interview_requests to service_role;
grant all on table public.ats_interview_request_items to service_role;

commit;
