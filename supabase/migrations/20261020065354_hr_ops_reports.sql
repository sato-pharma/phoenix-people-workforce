-- hr_ops_reports
--
-- WHAT THIS CHANGES: two new tables for the HR Operations Specialist's Daily & Weekly Reports
--   (src/lib/hr-ops-reports/).
--   * public.hr_ops_reports — one row per report: a DAILY report for one day, or a WEEKLY report
--     whose office section runs Sunday-Thursday and whose field section runs Saturday-Thursday.
--     Status moves in_review (hers) -> submitted (yours) -> decided.
--   * public.hr_ops_report_lines — one row per person per day per section (office = fingerprint,
--     field = visits). It carries the facts of that day (`metrics`: punches, lateness, AM/PM and
--     pharmacy visits, first and last visit, month-to-date visits), the issues found (`flags`), the
--     policy's suggested deduction in DAYS, HER review (confirm / reject / recommend an edit, with a
--     reason), YOUR decision, and how far the decision travelled into the weekly attendance review.
--   No amount is stored anywhere in these tables: days only. The owner's screen prices a day at read
--   time, on the server, and that figure never reaches her.
-- WHY: owner, 2026-10-20 — "daily and weekly fingerprint and field-force reports (AM/PM, start/end
--   times, visits to date)", every row "confirm or rejct or recommend edit with reason", deductions
--   "recommend in days only; she will never take desicion". The weekly report is "field force from
--   sat to thursday and head office from sun to thursday".
-- ROLLBACK: drop table public.hr_ops_report_lines; drop table public.hr_ops_reports; — both are new
--   and nothing outside src/lib/hr-ops-reports/ reads them. A decision already carried into the
--   weekly attendance review stays there; it is that review's own row.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: two new, empty tables.

begin;

create table if not exists public.hr_ops_reports (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null,
  -- 'daily:YYYY-MM-DD' or 'weekly:YYYY-MM-DD' (the Saturday the field week starts) — one report per
  -- period, so a rebuild updates its own row and a cron that fires twice cannot make a second one.
  period_key         text not null unique,
  -- Each section's own window; null when that section has no working day in the report (no office
  -- section on a Saturday daily, neither on a Friday).
  office_from        date,
  office_to          date,
  field_from         date,
  field_to           date,
  status             text not null default 'in_review',
  line_count         integer not null default 0,
  -- What the build could not read, said plainly (a holiday calendar that was unreachable, a source
  -- that failed) — never silently a smaller report.
  build_warnings     jsonb not null default '[]'::jsonb,
  built_at           timestamptz not null default now(),
  rebuilt_at         timestamptz,
  submitted_at       timestamptz,
  submitted_by_hr_id text,
  decided_at         timestamptz,
  decided_by_hr_id   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint hr_ops_reports_kind_check check (kind in ('daily', 'weekly')),
  constraint hr_ops_reports_status_check check (status in ('in_review', 'submitted', 'decided')),
  constraint hr_ops_reports_office_window_check check (
    (office_from is null and office_to is null) or (office_from is not null and office_to is not null and office_from <= office_to)
  ),
  constraint hr_ops_reports_field_window_check check (
    (field_from is null and field_to is null) or (field_from is not null and field_to is not null and field_from <= field_to)
  ),
  constraint hr_ops_reports_period_key_check check (period_key ~ '^(daily|weekly):[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

create table if not exists public.hr_ops_report_lines (
  id                   uuid primary key default gen_random_uuid(),
  report_id            uuid not null references public.hr_ops_reports (id) on delete cascade,
  section              text not null,
  work_date            date not null,
  -- The HR id as the directory shows it, and its canonical lower-case key (src/lib/hr-id.ts
  -- canonicalHrIdKey) for matching — attendance code upper-cases ids and permission code lower-cases
  -- them, so the key is the one spelling every join uses.
  hr_id                text not null,
  hr_key               text not null,
  employee_name        text not null,
  job_title            text,
  line_name            text,
  area_name            text,
  manager_name         text,
  metrics              jsonb not null default '{}'::jsonb,
  flags                text[] not null default '{}'::text[],
  -- The attendance policy's figure for the day, in days; null when the policy has none to offer.
  suggested_days       numeric(8, 4),
  -- HER review.
  review_action        text,
  review_reason        text,
  review_comment       text,
  recommended_days     numeric(8, 4),
  reviewed_by_hr_id    text,
  reviewed_at          timestamptz,
  -- YOUR decision.
  decision             text,
  decided_days         numeric(8, 4),
  decided_by_hr_id     text,
  decided_at           timestamptz,
  -- How the decision reached the weekly attendance review (src/lib/hr-ops-reports/bridge.ts).
  bridge_status        text not null default 'not_decided',
  bridge_ref           text,
  bridge_message       text,
  bridged_at           timestamptz,
  -- A weekly line for a day already decided in its daily report: shown, never decided twice.
  carried_from_line_id uuid references public.hr_ops_report_lines (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint hr_ops_report_lines_unique_day unique (report_id, section, hr_key, work_date),
  constraint hr_ops_report_lines_section_check check (section in ('office', 'field')),
  constraint hr_ops_report_lines_review_action_check check (review_action is null or review_action in ('confirm', 'reject', 'recommend_edit')),
  -- A reject or a recommended edit always says why; a confirm may.
  constraint hr_ops_report_lines_review_reason_check check (
    review_action is null or review_action = 'confirm' or nullif(btrim(coalesce(review_reason, '')), '') is not null
  ),
  -- Recommended days belong to a recommended edit and nothing else.
  constraint hr_ops_report_lines_recommended_days_check check (
    (review_action = 'recommend_edit' and recommended_days is not null and recommended_days >= 0)
    or (coalesce(review_action, '') <> 'recommend_edit' and recommended_days is null)
  ),
  constraint hr_ops_report_lines_suggested_days_check check (suggested_days is null or suggested_days >= 0),
  constraint hr_ops_report_lines_decision_check check (decision is null or decision in ('approved', 'rejected')),
  constraint hr_ops_report_lines_decided_days_check check (
    (decision = 'approved' and decided_days is not null and decided_days >= 0)
    or (coalesce(decision, '') <> 'approved' and decided_days is null)
  ),
  constraint hr_ops_report_lines_bridge_status_check check (
    bridge_status in ('not_decided', 'not_needed', 'waiting', 'bridged', 'week_released', 'failed')
  )
);

-- One approved deduction per person, day and section, across every report: a day raised in the daily
-- report and again in the weekly one can be approved once, and the second approval is refused here
-- even if two clicks race.
create unique index if not exists hr_ops_report_lines_one_approved_day
  on public.hr_ops_report_lines (section, hr_key, work_date)
  where decision = 'approved' and decided_days > 0;

create index if not exists hr_ops_report_lines_report_idx on public.hr_ops_report_lines (report_id, section, work_date);
create index if not exists hr_ops_report_lines_person_day_idx on public.hr_ops_report_lines (hr_key, work_date);
create index if not exists hr_ops_report_lines_bridge_waiting_idx
  on public.hr_ops_report_lines (bridge_status)
  where bridge_status in ('waiting', 'failed');
create index if not exists hr_ops_reports_status_idx on public.hr_ops_reports (status, kind);

alter table public.hr_ops_reports enable row level security;
alter table public.hr_ops_report_lines enable row level security;

-- Service role only: every read and write goes through the app's server routes, which check the
-- seat (hr_ops_reports: read/update for her, approve for the Super Admin). Nothing in a browser
-- touches these tables.
drop policy if exists phx_hr_ops_reports_service_role on public.hr_ops_reports;
create policy phx_hr_ops_reports_service_role
  on public.hr_ops_reports for all to service_role using (true) with check (true);

drop policy if exists phx_hr_ops_report_lines_service_role on public.hr_ops_report_lines;
create policy phx_hr_ops_report_lines_service_role
  on public.hr_ops_report_lines for all to service_role using (true) with check (true);

revoke all on public.hr_ops_reports from anon, authenticated;
revoke all on public.hr_ops_report_lines from anon, authenticated;
grant select, insert, update, delete on public.hr_ops_reports to service_role;
grant select, insert, update, delete on public.hr_ops_report_lines to service_role;

comment on table public.hr_ops_reports is
  'The HR Operations Specialist''s Daily & Weekly Reports (src/lib/hr-ops-reports/). One row per period; she reviews, the Super Admin decides. Days only — no amount is stored.';
comment on table public.hr_ops_report_lines is
  'One person, one day, one section (office fingerprint or field visits) of an HR ops report: the facts, the flags, the policy''s suggested days, her review, the Super Admin''s decision and how it reached the weekly attendance review. Days only — no amount is stored.';

do $$
begin
  if to_regclass('public.hr_ops_reports') is null or to_regclass('public.hr_ops_report_lines') is null then
    raise exception 'hr_ops_reports tables were not created';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'hr_ops_report_lines_one_approved_day') then
    raise exception 'the one-approval-per-day index is missing';
  end if;
end $$;

commit;
