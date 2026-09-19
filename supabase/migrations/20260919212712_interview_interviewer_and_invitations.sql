-- interview_interviewer_and_invitations
--
-- WHAT THIS CHANGES (additive only — nothing existing is rewritten or dropped):
--   * ats_interview_bookings.interviewer_hr_id  — the employee who conducts the interview (nullable).
--   * ats_interview_invitations                 — a log of every invitation the calendar prepared or
--                                                 sent for a booking: to whom, by which channel, when.
--
-- WHY: the owner, 2026-09-19 — on the interview calendar he wants to choose the interviewer as well as
-- the candidate, press one button and have the invitation reach both, each by WhatsApp or by e-mail
-- as he chooses, and to send the candidate the company's location, LinkedIn and website. The log is
-- what lets the screen say "sent to Nevin by e-mail at 4:12 PM" instead of guessing, and stops a
-- second press from looking like the first never happened.
--
-- A WhatsApp row is `opened`, never `sent`: WhatsApp is a click-to-chat link (the recruiter presses
-- Send inside WhatsApp — see src/lib/recruitment/whatsapp-templates/send-link.ts), so Phoenix cannot
-- know it was delivered. An e-mail row is `sent` or `failed`, as the mail provider answered.
--
-- ROLLBACK:
--   drop table if exists public.ats_interview_invitations;
--   alter table public.ats_interview_bookings drop column if exists interviewer_hr_id;
-- (Loses the invitation log and every interviewer chosen since. Nothing else reads either.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

begin;

alter table public.ats_interview_bookings
  add column if not exists interviewer_hr_id text;

comment on column public.ats_interview_bookings.interviewer_hr_id is
  'HR id of the employee conducting the interview; NULL when none was chosen. Stored as written, compared case-insensitively.';

create table if not exists public.ats_interview_invitations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ats_interview_bookings (id) on delete cascade,
  recipient text not null,
  channel text not null,
  kind text not null default 'invitation',
  status text not null,
  -- The e-mail address or the WhatsApp number it went to, as a person reads it back.
  destination text,
  detail text,
  sent_by_hr_id text,
  created_at timestamptz not null default now(),

  constraint ats_interview_invitations_recipient_valid check (recipient in ('candidate', 'interviewer')),
  constraint ats_interview_invitations_channel_valid check (channel in ('whatsapp', 'email')),
  constraint ats_interview_invitations_kind_valid check (kind in ('invitation', 'company_details')),
  constraint ats_interview_invitations_status_valid check (status in ('sent', 'opened', 'failed'))
);

comment on table public.ats_interview_invitations is
  'Invitations the interview calendar prepared or sent for a booking. WhatsApp = opened (click-to-chat), e-mail = sent or failed.';

create index if not exists ats_interview_invitations_booking_idx
  on public.ats_interview_invitations (booking_id, created_at);

-- Service role only, like the calendar's other tables: every read and write goes through
-- src/lib/recruitment/interview-invitations.ts after the calendar's own gate.
alter table public.ats_interview_invitations enable row level security;
revoke all on table public.ats_interview_invitations from anon, authenticated;
grant all on table public.ats_interview_invitations to service_role;

commit;
