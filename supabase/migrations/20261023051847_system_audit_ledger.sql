-- system_audit_ledger
--
-- WHAT THIS CHANGES:
--   Adds the System Error & Data Integrity Audit ledger — six new tables, nothing else touched:
--   1. public.system_audit_issues          one row per error signature (what went wrong), with its
--                                          fix status and root cause.
--   2. public.system_audit_issue_fixes     each fix attempt for an issue: the commit, when it went
--                                          live, and whether it was verified or later invalidated
--                                          by a recurrence.
--   3. public.system_audit_occurrences     one row per user-level operation that hit an issue: the
--                                          person, the exact sidebar module, the Cairo time, the
--                                          message, the evidence. Retries of one operation fold
--                                          into one row (attempt_count).
--   4. public.system_audit_status_history  append-only trail of every status change.
--   5. public.system_audit_detector_runs   one row per detector run: what it scanned, what it
--                                          excluded as noise (per class), and for the nightly
--                                          reconciliation run the whole report.
--   6. public.system_audit_watermarks      each detector's cursor plus a lease so two runs never
--                                          overlap.
--
-- WHY:
--   app_error_events is pruned at 90 days and its "resolved" status is derived from deploys, the
--   nightly reconciliation report was never stored, and no table recorded which person hit which
--   failure in which sidebar module. The ledger is the durable, evidence-based record the
--   Super Admin page /admin/system-audit reads. It holds no money and moves none.
--
-- ACCESS:
--   RLS on, one service_role policy per table, revoked from public, anon and authenticated. The
--   app reads it only through the service-role client behind assertSystemAdministratorWorkspaceAccess.
--
-- RETENTION:
--   Not pruned (owner rule 2026-10-04: nothing is pruned beyond the three tables he named).
--
-- ROLLBACK:
--   drop table if exists public.system_audit_status_history, public.system_audit_occurrences,
--     public.system_audit_issue_fixes, public.system_audit_issues, public.system_audit_detector_runs,
--     public.system_audit_watermarks cascade;
--   drop function if exists public.system_audit_refuse_history_change();
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration changes no existing application data.

begin;
set local lock_timeout = '5s';

create table if not exists public.system_audit_issues (
  id uuid primary key default gen_random_uuid(),
  signature_key text not null,
  family text not null,
  error_code text not null,
  title text not null,
  status text not null default 'investigating',
  root_cause_level text not null default 'unknown',
  root_cause text,
  root_cause_evidence jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  -- What the one daily message last told the owner about this issue, so the next message carries
  -- only what is new, newly shared or reopened.
  alerted_at timestamptz,
  alerted_people integer not null default 0,
  alerted_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint system_audit_issues_signature_key_unique unique (signature_key),
  constraint system_audit_issues_family_check check (family in
    ('app_error', 'reconciliation', 'visit_lifecycle', 'sync_run', 'job_failure', 'data_linkage')),
  constraint system_audit_issues_status_check check (status in
    ('fixed_verified', 'not_fixed', 'investigating', 'fix_implemented', 'no_defect', 'unknown')),
  constraint system_audit_issues_root_cause_level_check check (root_cause_level in ('confirmed', 'probable', 'unknown')),
  constraint system_audit_issues_evidence_size check (pg_column_size(root_cause_evidence) <= 8192)
);

create table if not exists public.system_audit_issue_fixes (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.system_audit_issues (id) on delete restrict,
  generation integer not null,
  fix_commit_sha text not null,
  fix_live_at timestamptz not null,
  verified_at timestamptz,
  verification jsonb,
  invalidated_at timestamptz,
  invalidated_by_occurrence uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint system_audit_issue_fixes_generation_unique unique (issue_id, generation),
  constraint system_audit_issue_fixes_sha_check check (fix_commit_sha ~ '^[0-9a-f]{40}$')
);

create table if not exists public.system_audit_occurrences (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  issue_id uuid not null references public.system_audit_issues (id) on delete restrict,
  signature_key text not null,
  family text not null,
  correlation_id uuid,
  is_root_symptom boolean not null default true,
  hr_key text,
  hr_id_display text,
  employee_name text,
  role_at_event text,
  module_label text not null,
  module_label_source text not null,
  shell text,
  route text,
  occurred_at timestamptz not null,
  occurred_at_kind text not null,
  occurred_cairo_date date generated always as ((occurred_at at time zone 'Africa/Cairo')::date) stored,
  affected_date date,
  user_message text,
  is_silent boolean not null default false,
  technical_message text,
  error_code text not null,
  related_table text,
  related_id text,
  attempt_count integer not null default 1,
  page_loads integer not null default 1,
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  source_refs jsonb not null default '[]'::jsonb,
  release text,
  pre_fix_build boolean not null default false,
  triage_override text,
  triage_reason text,
  evidence jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  detector_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint system_audit_occurrences_dedupe_key_unique unique (dedupe_key),
  constraint system_audit_occurrences_label_source_check check (module_label_source in
    ('nav_exact', 'nav_parent', 'page_trail', 'api_map', 'detector', 'none')),
  constraint system_audit_occurrences_kind_check check (occurred_at_kind in ('failure', 'event', 'detected')),
  constraint system_audit_occurrences_triage_check check (triage_override is null or triage_override in ('no_defect', 'unknown')),
  constraint system_audit_occurrences_message_length check (technical_message is null or char_length(technical_message) <= 1000),
  constraint system_audit_occurrences_counts_check check (attempt_count >= 1 and page_loads >= 1),
  constraint system_audit_occurrences_refs_check check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) <= 50),
  constraint system_audit_occurrences_evidence_size check (pg_column_size(evidence) <= 4096)
);

create index if not exists system_audit_occurrences_time_idx
  on public.system_audit_occurrences (occurred_at desc, id desc) where not is_test;
create index if not exists system_audit_occurrences_signature_idx
  on public.system_audit_occurrences (signature_key, occurred_at) include (hr_key, correlation_id) where not is_test;
create index if not exists system_audit_occurrences_person_idx
  on public.system_audit_occurrences (hr_key, occurred_at);
create index if not exists system_audit_occurrences_issue_idx
  on public.system_audit_occurrences (issue_id, occurred_at);
create index if not exists system_audit_occurrences_correlation_idx
  on public.system_audit_occurrences (correlation_id) where correlation_id is not null;
create index if not exists system_audit_occurrences_fold_idx
  on public.system_audit_occurrences (signature_key, hr_key, last_event_at desc);
create index if not exists system_audit_issue_fixes_issue_idx
  on public.system_audit_issue_fixes (issue_id, fix_live_at);

create table if not exists public.system_audit_status_history (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.system_audit_issues (id) on delete restrict,
  occurrence_id uuid,
  from_status text,
  to_status text not null,
  actor text not null,
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists system_audit_status_history_issue_idx
  on public.system_audit_status_history (issue_id, created_at);

create table if not exists public.system_audit_detector_runs (
  id uuid primary key default gen_random_uuid(),
  run_group uuid,
  detector text not null,
  mode text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  watermark_from jsonb,
  watermark_to jsonb,
  scanned integer not null default 0,
  excluded_counts jsonb not null default '{}'::jsonb,
  inserted integer not null default 0,
  updated integer not null default 0,
  unreadable_sources jsonb not null default '[]'::jsonb,
  report jsonb,
  error text,
  release text,
  constraint system_audit_detector_runs_mode_check check (mode in ('cron', 'historical', 'manual')),
  constraint system_audit_detector_runs_status_check check (status in
    ('running', 'ok', 'partial', 'budget_exhausted', 'aborted_db_unhealthy', 'errored', 'skipped')),
  constraint system_audit_detector_runs_report_size check (report is null or pg_column_size(report) <= 262144)
);
create index if not exists system_audit_detector_runs_detector_idx
  on public.system_audit_detector_runs (detector, started_at desc);

create table if not exists public.system_audit_watermarks (
  detector text primary key,
  cursor jsonb not null default '{}'::jsonb,
  lease_holder text,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);

-- The status trail is append-only: rows are never edited, deleted or truncated. A row trigger
-- misses TRUNCATE, so a statement-level BEFORE TRUNCATE trigger refuses it too.
create or replace function public.system_audit_refuse_history_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'system_audit_status_history is append-only (% refused)', tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists system_audit_status_history_no_update on public.system_audit_status_history;
create trigger system_audit_status_history_no_update
  before update or delete on public.system_audit_status_history
  for each row execute function public.system_audit_refuse_history_change();

drop trigger if exists system_audit_status_history_no_truncate on public.system_audit_status_history;
create trigger system_audit_status_history_no_truncate
  before truncate on public.system_audit_status_history
  for each statement execute function public.system_audit_refuse_history_change();

revoke execute on function public.system_audit_refuse_history_change() from public, anon, authenticated;

do $do$
declare
  v_table text;
begin
  foreach v_table in array array[
    'system_audit_issues',
    'system_audit_issue_fixes',
    'system_audit_occurrences',
    'system_audit_status_history',
    'system_audit_detector_runs',
    'system_audit_watermarks'
  ]
  loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('drop policy if exists %I on public.%I', v_table || '_service_role', v_table);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      v_table || '_service_role', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert, update, delete on table public.%I to service_role', v_table);
  end loop;
end
$do$;

-- The trail stays append-only for the service role too.
revoke update, delete, truncate on table public.system_audit_status_history from service_role;

comment on table public.system_audit_issues is
  'System Error & Data Integrity Audit: one row per error signature, with its fix status and root cause. Read by /admin/system-audit (Super Admin only). Never pruned.';
comment on table public.system_audit_occurrences is
  'System Error & Data Integrity Audit: one row per user-level operation that hit an issue (retries folded), with the person, exact sidebar module and Cairo time. Never pruned.';
comment on table public.system_audit_status_history is
  'Append-only trail of every System Audit status change. UPDATE, DELETE and TRUNCATE are refused.';

commit;
