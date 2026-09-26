-- ats_interview_ics_feed_tokens
--
-- WHAT THIS CHANGES: one NEW table, ats_interview_ics_feed_tokens — a private, per-person token that
--   lets someone subscribe to their own interviews from their normal calendar app (Outlook, Google,
--   the phone), read-only, over an .ics feed. One row per person (hr_id), one long random token.
--
-- WHY: the owner, 2026-09-26 — make the interview calendar "relevant for everyone daily". Interviews
--   appear in the calendar people already live in, with no new habit, instead of only on the
--   Phoenix screen. The token is a bearer secret so a calendar app with no Phoenix sign-in can read
--   the feed; the feed shows only that one person's own interviews (as interviewer or requester).
--
-- Service-role only: RLS on, no policy, nothing granted to anon or authenticated — the same shape
-- as 20260918195837 and 20260918215608. The feed route reads it with the service-role client and
-- returns only the matching person's events; the token itself is a bearer secret.
--
-- ROLLBACK:
--   drop table public.ats_interview_ics_feed_tokens;
--   Nothing below deletes or rewrites an existing row — it only adds a new, empty table.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This is
-- additive and non-destructive: a new empty table only.

begin;

create table if not exists public.ats_interview_ics_feed_tokens (
  hr_id text primary key,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ats_interview_ics_feed_tokens enable row level security;

revoke all on table public.ats_interview_ics_feed_tokens from anon, authenticated;

commit;
