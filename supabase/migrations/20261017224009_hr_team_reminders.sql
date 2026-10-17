-- hr_team_reminders
--
-- WHAT THIS CHANGES: two NEW tables, both empty on arrival, nothing existing is touched.
--
--   hr_reminders          — one row per note / reminder the HR team writes. A row with no
--                           remind_on is a plain note (it shows in the notes view only); a row
--                           with a date also lands on the week and month calendars. Who may SEE a
--                           row is decided in TypeScript from owner_hr_id, share_with_team and
--                           shared_with_hr_ids (src/lib/hr-reminders/logic.ts), never by RLS —
--                           this app reads through the service role, so a policy would protect
--                           nothing the app itself hands out.
--
--   hr_reminder_comments  — the conversation under one row. A flat thread, oldest first, with an
--                           optional reply_to_id so a reply can quote the comment it answers.
--
-- WHY: the owner (HR Manager, 2026-10-17) asked for a small shared-notes module for the HR team
-- — himself, the HR Generalist, Talent Acquisition and the office coordinator to come. Each person
-- writes notes and reminders, chooses per item whether a teammate may see it, and views them as a
-- list, a week or a month. He sees every item whatever its sharing, and may open a conversation
-- on any of them.
--
-- Hr ids are stored in canonical casing (hrIdForStorage). They are text, not foreign keys, on
-- purpose: employees.hr_id has lived in mixed case and a person can hold two logins (the
-- administrator console is the same human as B-10), so the id written is the PERSON's canonical id
-- and a foreign key would only reject the alias spelling.
--
-- A removed note is soft-deleted (deleted_at), never hard-deleted: the HR Manager reads every
-- item, so a note somebody removed is still on record for him.
--
-- ROLLBACK: nothing else reads these tables, so a later migration may remove them — comments
-- first, then reminders. Reverting the pull request alone does not undo this file.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This file is neither: it creates two empty tables.

begin;

create table if not exists public.hr_reminders (
  id uuid primary key default gen_random_uuid(),

  -- The author. Canonical person id (B-10, never the console alias).
  owner_hr_id text not null check (btrim(owner_hr_id) <> ''),

  title text not null check (char_length(btrim(title)) between 1 and 200),
  body text not null default '' check (char_length(body) <= 4000),

  -- Cairo calendar day. NULL = a plain note with no day.
  remind_on date,
  -- Cairo wall-clock times, only meaningful with a day.
  starts_at time,
  ends_at time,

  -- A colour from the Phoenix palette, chosen by the author to tell items apart at a glance.
  color text not null default 'orange' check (color in ('ink', 'ember', 'orange', 'amber', 'slate')),

  status text not null default 'open' check (status in ('open', 'done')),
  done_at timestamptz,
  done_by_hr_id text,

  -- Sharing. PRIVATE (the default) means the author and the HR Manager only. share_with_team
  -- means everyone on the HR team today and anyone who joins later; shared_with_hr_ids names
  -- individual teammates. The two combine harmlessly: the team flag already covers everyone.
  share_with_team boolean not null default false,
  shared_with_hr_ids text[] not null default '{}'::text[],

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by_hr_id text,

  constraint hr_reminders_time_needs_day check (starts_at is null or remind_on is not null),
  constraint hr_reminders_end_needs_start check (ends_at is null or starts_at is not null),
  constraint hr_reminders_end_after_start check (ends_at is null or ends_at > starts_at),
  constraint hr_reminders_done_stamp check (status = 'open' or done_at is not null)
);

comment on table public.hr_reminders is
  'Notes and reminders written by the HR team. Visibility is decided in TypeScript (src/lib/hr-reminders/logic.ts), not by RLS: owner and the HR Manager always, plus share_with_team or shared_with_hr_ids.';

create index if not exists hr_reminders_owner_idx
  on public.hr_reminders (owner_hr_id)
  where deleted_at is null;

create index if not exists hr_reminders_day_idx
  on public.hr_reminders (remind_on)
  where deleted_at is null and remind_on is not null;

create table if not exists public.hr_reminder_comments (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.hr_reminders (id) on delete cascade,
  -- The comment this one answers, so the thread can show "replying to …". The parent staying
  -- is not required: the reply keeps its own text if the parent row is ever removed.
  reply_to_id uuid references public.hr_reminder_comments (id) on delete set null,
  author_hr_id text not null check (btrim(author_hr_id) <> ''),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

comment on table public.hr_reminder_comments is
  'The conversation under one hr_reminders row — flat, oldest first, with an optional reply_to_id. No edit path exists in the app.';

create index if not exists hr_reminder_comments_thread_idx
  on public.hr_reminder_comments (reminder_id, created_at);

alter table public.hr_reminders enable row level security;
alter table public.hr_reminder_comments enable row level security;

-- Service role only. Neither table is ever read by a browser role.
revoke all on table public.hr_reminders from anon, authenticated;
revoke all on table public.hr_reminder_comments from anon, authenticated;

create policy phx_hr_reminders_service_role on public.hr_reminders
  for all
  to service_role
  using (true)
  with check (true);

create policy phx_hr_reminder_comments_service_role on public.hr_reminder_comments
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.hr_reminders to service_role;
grant all on table public.hr_reminder_comments to service_role;

commit;
