-- private_calendar_day_records
--
-- Every record is a WHOLE day: a half-day conference names nobody, and the Super Admin records whole days.
--
-- WHAT THIS ADDS (owner, 28 Nov 2026): one table of DAY RECORDS — a working day recorded FOR a person who
-- had no record of his own that day. Two writers, both server-side only:
--   1. super_admin — the Super Admin picks people (grouped by job, multi-tick, e.g. every District Sales
--      Manager but one) and records one day for all of them in one step: "we all had a meeting on Thursday".
--   2. rep_named   — a rep logging a Conference day in Phoenix CRM names who from the line was with him.
-- NOTHING IS AUTOMATIC (owner, 28 Nov 2026: "never automatic"): a day record covers a day only once its
-- status is 'confirmed'. The Super Admin's own entry is confirmed when he saves it; a rep's naming starts
-- 'pending' and waits for his answer. A line's training day is never stored on its own — Phoenix asks him
-- "was she with them?", day by day, and writes 'confirmed' for each day he ticks and 'declined' for each
-- day he leaves, so a day once answered is never asked again.
-- A confirmed record is an entry on the person's Private Calendar AND a source that proves the day was worked,
-- so the No records deduction drops it (src/lib/private-calendar/day-records.ts, read by loadProvenWorkedDays).
-- A record is never deleted: it is voided (voided_at), so what was entered stays readable.
--
-- WHY: owner, 28 Nov 2026 — a Group Product Manager with no punch and no visit was charged on the days her
-- line was in training; "these activities must be synchronized in her private calendar and not shows as
-- deductions for now and for upcomings".
--
-- ROLLBACK: drop table public.private_calendar_day_records;   -- loses every day record: export it first
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new empty table and two indexes. No row is changed.

begin;
set local lock_timeout = '5s';

create table if not exists public.private_calendar_day_records (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null check (length(btrim(employee_hr_id)) > 0),
  record_date date not null,
  activity_type text not null check (activity_type in ('meeting', 'training', 'conference', 'group_meeting', 'admin_work', 'travel', 'other')),
  note text check (note is null or length(note) <= 500),
  origin text not null check (origin in ('super_admin', 'rep_named', 'line_training')),
  status text not null check (status in ('pending', 'confirmed', 'declined')),
  entered_by_hr_id text not null check (length(btrim(entered_by_hr_id)) > 0),
  -- The rep who named this person on his Conference day (origin rep_named); null for the Super Admin's own entry.
  named_by_hr_id text,
  -- One save, many people: every row of one step shares its batch.
  batch_id uuid not null,
  -- Who answered a pending record or a line-training question, and when.
  decided_by_hr_id text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by_hr_id text,
  constraint private_calendar_day_records_named_by check ((origin = 'rep_named') = (named_by_hr_id is not null)),
  -- Only a rep's naming waits for an answer; the Super Admin's own entry and his answers are decided already.
  constraint private_calendar_day_records_pending check (status <> 'pending' or origin = 'rep_named')
);

comment on table public.private_calendar_day_records is
  'Working days recorded FOR a person with no record of his own that day: by the Super Admin in one grouped step, his answer to a line-training question, or a rep naming him on a Conference day (owner, 28 Nov 2026). Only status confirmed covers a day: an entry on the Private Calendar and a proven worked day for the deductions. Never automatic. Voided, never deleted. Service role only. See src/lib/private-calendar/day-records.ts.';

create index if not exists private_calendar_day_records_date_idx
  on public.private_calendar_day_records (record_date) where voided_at is null;
create index if not exists private_calendar_day_records_person_idx
  on public.private_calendar_day_records (upper(employee_hr_id), record_date) where voided_at is null;

alter table public.private_calendar_day_records enable row level security;
drop policy if exists private_calendar_day_records_service_role on public.private_calendar_day_records;
create policy private_calendar_day_records_service_role
  on public.private_calendar_day_records for all to service_role using (true) with check (true);
revoke all on table public.private_calendar_day_records from public, anon, authenticated;
grant all on table public.private_calendar_day_records to service_role;

commit;
