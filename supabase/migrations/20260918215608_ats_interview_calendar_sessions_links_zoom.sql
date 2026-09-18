-- ats_interview_calendar_sessions_links_zoom
--
-- WHAT THIS CHANGES: the interview calendar's second part, the owner's requests of 2026-09-18.
--   1. ats_interview_sessions (NEW) — one meeting for a block of a day ("day 20 from 11 a.m. to
--      3 p.m."), cut into slots that each take a candidate and share the block's one Zoom link.
--   2. ats_interview_bookings — an interview may now be for someone OUTSIDE Phoenix (a name, a
--      phone, an e-mail and a CV kept on the booking alone, never a recruitment record), may sit
--      in a session's slot, and may run up to the whole 9-to-5 day (480 minutes, was 240).
--      candidate_id becomes nullable for that; a new check keeps every booking naming a person.
--   3. ats_interview_calendar_links (NEW) — "copy link", as Google Sheets does it: a link with a
--      level (viewer, commenter, editor), for the whole calendar or for one week, switched off and
--      on by the owner. Holding it VIEWS without signing in; comment and edit need a sign-in.
--   4. ats_interview_poll_sets (NEW) — polls saved once, attached to any Zoom interview in a click.
--   5. ats_interview_zoom_polls (NEW) — the polls put on a Zoom interview's (or session's) meeting.
--   6. ats_interview_zoom_insights (NEW) — what Zoom reports after a meeting, cached: who joined
--      and for how long, the poll answers, and the AI Companion's meeting summary.
--
-- WHY: the owner, in chat — "build Zoom attendance, polls, invitation and AI summary into the
-- interview calendar", a copy link he controls "exactly as google sheets", Zoom blocks, and
-- pressable cells that book a Phoenix candidate or someone from outside with their CV.
--
-- Every new table is service-role only: RLS on, no policy, and nothing granted to anon or
-- authenticated — the same shape as 20260918195837. The link table holds bearer tokens.
--
-- ROLLBACK:
--   drop table public.ats_interview_zoom_insights, public.ats_interview_zoom_polls,
--     public.ats_interview_poll_sets, public.ats_interview_calendar_links;
--   alter table public.ats_interview_bookings drop column session_id, drop column external_name,
--     drop column external_phone, drop column external_email, drop column external_cv_file_id,
--     drop column external_cv_file_name, drop column external_cv_mime_type;
--   drop table public.ats_interview_sessions;
--   and, ONLY once no booking is for an outside person or longer than 240 minutes, put back
--   candidate_id not null and the 15–240 duration check. Nothing here deletes or rewrites a row.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing below is either: new tables, new nullable columns, and two relaxed checks.

begin;

-- ── 1. Sessions ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.ats_interview_sessions (
  id uuid primary key default gen_random_uuid(),
  title text,
  starts_at timestamptz not null,
  duration_minutes integer not null,
  slot_minutes integer not null default 30,
  platform text not null,
  zoom_status text not null default 'not_needed',
  zoom_meeting_id text,
  zoom_join_url text,
  zoom_error text,
  notes text,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ats_interview_sessions_platform_valid check (platform in ('in_office', 'zoom')),
  constraint ats_interview_sessions_zoom_status_valid
    check (zoom_status in ('not_needed', 'created', 'not_connected', 'failed')),
  constraint ats_interview_sessions_office_has_no_meeting
    check (platform = 'zoom' or (zoom_status = 'not_needed' and zoom_meeting_id is null and zoom_join_url is null)),
  constraint ats_interview_sessions_duration_valid
    check (duration_minutes between 30 and 480 and duration_minutes % 15 = 0),
  constraint ats_interview_sessions_slot_valid
    check (slot_minutes in (15, 30, 45, 60) and slot_minutes <= duration_minutes),
  constraint ats_interview_sessions_title_length check (title is null or length(title) <= 120),
  constraint ats_interview_sessions_notes_length check (notes is null or length(notes) <= 1000)
);

comment on table public.ats_interview_sessions is
  'A block of interviews on one day under ONE meeting, cut into slots of slot_minutes; each slot takes a booking (ats_interview_bookings.session_id). Nothing is sent to a candidate.';

create index if not exists ats_interview_sessions_starts_at_idx
  on public.ats_interview_sessions (starts_at);

-- ── 2. Bookings: outside candidates, session slots, whole-day length ───────────────────────────
alter table public.ats_interview_bookings alter column candidate_id drop not null;

alter table public.ats_interview_bookings
  add column if not exists session_id uuid references public.ats_interview_sessions (id) on delete cascade,
  add column if not exists external_name text,
  add column if not exists external_phone text,
  add column if not exists external_email text,
  add column if not exists external_cv_file_id text,
  add column if not exists external_cv_file_name text,
  add column if not exists external_cv_mime_type text;

comment on column public.ats_interview_bookings.session_id is
  'The session whose slot this interview fills; it then uses the session''s meeting and has none of its own. Deleting the session deletes its slots.';
comment on column public.ats_interview_bookings.external_name is
  'An interview for someone outside Phoenix, kept on the calendar only (the booker chose not to add them to Recruitment). Set when candidate_id is null.';
comment on column public.ats_interview_bookings.external_cv_file_id is
  'The outside person''s CV, in the recruitment file storage, reachable only through the calendar. Never an ats_files row.';

alter table public.ats_interview_bookings drop constraint if exists ats_interview_bookings_has_person;
alter table public.ats_interview_bookings add constraint ats_interview_bookings_has_person
  check (candidate_id is not null or (external_name is not null and length(btrim(external_name)) > 0));

alter table public.ats_interview_bookings drop constraint if exists ats_interview_bookings_external_lengths;
alter table public.ats_interview_bookings add constraint ats_interview_bookings_external_lengths
  check (
    (external_name is null or length(external_name) <= 200)
    and (external_phone is null or length(external_phone) <= 40)
    and (external_email is null or length(external_email) <= 200)
    and (external_cv_file_name is null or length(external_cv_file_name) <= 255)
  );

alter table public.ats_interview_bookings drop constraint if exists ats_interview_bookings_duration_valid;
alter table public.ats_interview_bookings add constraint ats_interview_bookings_duration_valid
  check (duration_minutes between 15 and 480 and duration_minutes % 15 = 0);

create index if not exists ats_interview_bookings_session_idx
  on public.ats_interview_bookings (session_id)
  where session_id is not null;

-- ── 3. Copy-link access ────────────────────────────────────────────────────────────────────────
create table if not exists public.ats_interview_calendar_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  access_level text not null,
  week_start date,
  guest_cvs boolean not null default true,
  is_active boolean not null default true,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  use_count integer not null default 0,
  constraint ats_interview_calendar_links_level_valid check (access_level in ('viewer', 'commenter', 'editor')),
  constraint ats_interview_calendar_links_token_length check (length(token) >= 32),
  constraint ats_interview_calendar_links_week_is_sunday check (week_start is null or extract(dow from week_start) = 0)
);

comment on table public.ats_interview_calendar_links is
  'Bearer links to the interview calendar, owner-managed. Holding one VIEWS without signing in (the CVs too, unless guest_cvs is off); a signed-in holder gets access_level. week_start null = the whole calendar, else that Sunday''s week only. is_active false = switched off.';

-- ── 4. Saved poll sets ─────────────────────────────────────────────────────────────────────────
create table if not exists public.ats_interview_poll_sets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  questions jsonb not null,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ats_interview_poll_sets_name_valid check (length(btrim(name)) between 1 and 120),
  constraint ats_interview_poll_sets_questions_valid
    check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) between 1 and 25)
);

comment on table public.ats_interview_poll_sets is
  'Interview polls saved once to attach to any Zoom interview. questions = [{name, type: single|multiple|short_answer, answers: [...]}].';

-- ── 5. Polls on a meeting ──────────────────────────────────────────────────────────────────────
create table if not exists public.ats_interview_zoom_polls (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.ats_interview_bookings (id) on delete cascade,
  session_id uuid references public.ats_interview_sessions (id) on delete cascade,
  poll_set_id uuid references public.ats_interview_poll_sets (id) on delete set null,
  title text not null,
  questions jsonb not null,
  zoom_meeting_id text,
  zoom_poll_id text,
  status text not null default 'pending',
  error text,
  created_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ats_interview_zoom_polls_one_owner check ((booking_id is null) <> (session_id is null)),
  constraint ats_interview_zoom_polls_status_valid check (status in ('pending', 'created', 'failed')),
  constraint ats_interview_zoom_polls_title_valid check (length(btrim(title)) between 1 and 120),
  constraint ats_interview_zoom_polls_questions_valid
    check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) between 1 and 25)
);

comment on table public.ats_interview_zoom_polls is
  'A poll put on the Zoom meeting of one interview (booking_id) or one session (session_id). status: created on Zoom | pending (no meeting yet) | failed (see error).';

create index if not exists ats_interview_zoom_polls_booking_idx
  on public.ats_interview_zoom_polls (booking_id) where booking_id is not null;
create index if not exists ats_interview_zoom_polls_session_idx
  on public.ats_interview_zoom_polls (session_id) where session_id is not null;

-- ── 6. What Zoom reported after a meeting ──────────────────────────────────────────────────────
create table if not exists public.ats_interview_zoom_insights (
  zoom_meeting_id text primary key,
  instance_uuid text,
  started_at timestamptz,
  ended_at timestamptz,
  attendance jsonb,
  attendance_note text,
  poll_results jsonb,
  poll_note text,
  summary jsonb,
  summary_note text,
  fetched_at timestamptz not null default now()
);

comment on table public.ats_interview_zoom_insights is
  'Zoom''s after-meeting reports for a calendar meeting, cached: attendance, poll answers, AI Companion summary. A *_note says why a part is missing (not held yet, not enabled, refused).';

-- ── Service-role only, every one ───────────────────────────────────────────────────────────────
alter table public.ats_interview_sessions enable row level security;
alter table public.ats_interview_calendar_links enable row level security;
alter table public.ats_interview_poll_sets enable row level security;
alter table public.ats_interview_zoom_polls enable row level security;
alter table public.ats_interview_zoom_insights enable row level security;

revoke all on table public.ats_interview_sessions from anon, authenticated;
revoke all on table public.ats_interview_calendar_links from anon, authenticated;
revoke all on table public.ats_interview_poll_sets from anon, authenticated;
revoke all on table public.ats_interview_zoom_polls from anon, authenticated;
revoke all on table public.ats_interview_zoom_insights from anon, authenticated;

grant all on table public.ats_interview_sessions to service_role;
grant all on table public.ats_interview_calendar_links to service_role;
grant all on table public.ats_interview_poll_sets to service_role;
grant all on table public.ats_interview_zoom_polls to service_role;
grant all on table public.ats_interview_zoom_insights to service_role;

-- Prove it, rather than report success and hope.
do $verify$
declare
  v_table text;
begin
  foreach v_table in array array[
    'ats_interview_sessions', 'ats_interview_calendar_links', 'ats_interview_poll_sets',
    'ats_interview_zoom_polls', 'ats_interview_zoom_insights'
  ] loop
    if to_regclass('public.' || v_table) is null then
      raise exception '% was not created', v_table;
    end if;
    if not (select relrowsecurity from pg_class where oid = to_regclass('public.' || v_table)) then
      raise exception 'RLS is not enabled on %', v_table;
    end if;
    if has_table_privilege('anon', 'public.' || v_table, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') then
      raise exception 'the browser key can still read %', v_table;
    end if;
    if not has_table_privilege('service_role', 'public.' || v_table, 'SELECT') then
      raise exception 'service_role cannot read % — the calendar would break', v_table;
    end if;
  end loop;
end
$verify$;

commit;
