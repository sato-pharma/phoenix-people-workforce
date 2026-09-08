-- Weekly attendance digest — rebuilt 2026-09-08 at the owner's instruction.
--
-- The 2026-07 original was dropped by 20260722103000_drop_attendance_digest_feature
-- after its employee-facing half was switched off within three weeks: the detection
-- engine was charging people on days our own records already explained. That defect
-- was fixed on 2026-09-08 (PRs #3483/#3488) and re-measured at a 0.00% false-positive
-- rate across five closed months, which is the precondition this rebuild waited for.
--
-- WHAT IS DELIBERATELY DIFFERENT FROM THE 2026-07 SHAPE
--
--   • This module NEVER creates a deduction. The month-end Fingerprint connector in
--     src/lib/deductions/ stays the only writer of deductions_candidates; a digest
--     line records the EMPLOYEE'S ANSWER and nothing else, and the answer is applied
--     to the candidate when the connector creates it. Two writers of the same
--     employee-day is how this database once charged 19 employee-days twice
--     (8,822.54 EGP, July 2026) — see the reconcile note in src/lib/deductions/collect.ts.
--
--   • `dry_run` therefore means "record answers, send nothing to payroll", and it
--     DEFAULTS TRUE. Owner decision 2026-09-08: silence auto-confirms after 48h, which
--     applies a salary deduction with no human approval — the first cycle proves the
--     numbers before that can bite.
--
-- Tables:
--   attendance_weekly_digests   — one row per (employee, cycle, week 1-4)
--   attendance_digest_lines     — one row per deductible day inside a digest
--   attendance_settlements      — IMMUTABLE ledger of every final outcome
--   attendance_digest_settings  — singleton config
--
-- All service_role-only (RLS + explicit revoke), matching the rest of the attendance
-- module: the app reaches them only through the server-side admin client.

begin;

-- ---------------------------------------------------------------------------
-- Config singleton
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_digest_settings (
  id                    smallint primary key default 1 check (id = 1),
  dispute_reviewer_hr_ids text[]    not null default '{}',
  cc_manager            boolean     not null default true,
  cc_ceo                boolean     not null default true,
  auto_confirm_hours    integer     not null default 48 check (auto_confirm_hours > 0),
  cycle_anchor_day      smallint    not null default 24 check (cycle_anchor_day between 1 and 28),
  -- Owner decision 2026-09-08: all three channels.
  channel_in_app        boolean     not null default true,
  channel_telegram      boolean     not null default true,
  channel_email         boolean     not null default true,
  -- Owner decision 2026-09-08: the employee sees the estimated amount.
  show_estimated_amount boolean     not null default true,
  -- TRUE = answers are recorded and notified, but no payroll decision is applied.
  dry_run               boolean     not null default true,
  enabled               boolean     not null default false,
  updated_at            timestamptz not null default now(),
  updated_by            text        null
);
insert into public.attendance_digest_settings (id) values (1)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Weekly digest (one per employee per settlement week)
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_weekly_digests (
  id                    bigserial primary key,
  employee_hr_id        text        not null,
  cycle_key             text        not null,               -- '2026-09' = 24 Aug -> 23 Sep
  week_index            smallint    not null check (week_index between 1 and 4),
  week_start            date        not null,
  week_end              date        not null,
  status                text        not null default 'draft'
                        check (status in ('draft', 'sent', 'settled', 'void')),
  channels              jsonb       not null default '{}'::jsonb,
  sent_at               timestamptz null,
  auto_confirm_at       timestamptz null,                    -- sent_at + auto_confirm_hours
  total_deduction_days  numeric(8,3) not null default 0,
  total_deduction_value numeric(12,2) not null default 0,
  currency              text        not null default 'EGP',
  dry_run               boolean     not null default true,   -- frozen per digest, not read live
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (employee_hr_id, cycle_key, week_index)
);
create index if not exists attendance_weekly_digests_employee_idx
  on public.attendance_weekly_digests (employee_hr_id, cycle_key);
create index if not exists attendance_weekly_digests_auto_confirm_idx
  on public.attendance_weekly_digests (auto_confirm_at)
  where status = 'sent';

-- ---------------------------------------------------------------------------
-- Digest lines (one per deductible day)
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_digest_lines (
  id                     bigserial primary key,
  digest_id              bigint      not null references public.attendance_weekly_digests(id) on delete cascade,
  work_date              date        not null,
  status                 text        not null
                         check (status in ('late', 'short_hours', 'early_leave', 'missing_punch')),
  late_minutes           integer     not null default 0,
  short_minutes          integer     not null default 0,
  worked_minutes         integer     not null default 0,
  deduction_days         numeric(8,3) not null default 0,
  deduction_value        numeric(12,2) not null default 0,
  reason                 text        null,
  -- The contradicting evidence, carried so a disputed day can be judged without
  -- re-running the report. The 2026-07 module showed the reviewer a charge with none
  -- of this and four wrong deductions were approved on 2026-08-05 as a result.
  evidence               jsonb       not null default '{}'::jsonb,
  action                 text        not null default 'pending'
                         check (action in ('pending', 'confirmed', 'disputed', 'auto_confirmed')),
  acted_at               timestamptz null,
  dispute_reason         text        null,
  dispute_attachment_url text        null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (digest_id, work_date)
);
create index if not exists attendance_digest_lines_digest_idx
  on public.attendance_digest_lines (digest_id);

-- ---------------------------------------------------------------------------
-- Settlement ledger (IMMUTABLE — the permanent record of an employee's answer)
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_settlements (
  id                bigserial primary key,
  digest_line_id    bigint      not null unique references public.attendance_digest_lines(id),
  employee_hr_id    text        not null,
  work_date         date        not null,
  action            text        not null
                    check (action in ('confirmed', 'auto_confirmed', 'dispute_upheld', 'dispute_rejected')),
  deduction_days    numeric(8,3) not null default 0,
  deduction_value   numeric(12,2) not null default 0,
  actor_hr_id       text        null,                 -- null = system (auto-confirm)
  actor_role        text        null,
  reviewer_hr_id    text        null,
  reason            text        null,
  delivery          jsonb       not null default '{}'::jsonb,
  -- Set once the month-end connector has created the candidate this answer applies to.
  applied_candidate_id uuid     null,
  applied_at        timestamptz null,
  decided_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index if not exists attendance_settlements_employee_idx
  on public.attendance_settlements (employee_hr_id, work_date);
create index if not exists attendance_settlements_unapplied_idx
  on public.attendance_settlements (work_date)
  where applied_candidate_id is null;
-- Double-answer guard: one employee-day can be settled with a real deduction once.
create unique index if not exists attendance_settlements_no_double_deduction_idx
  on public.attendance_settlements (employee_hr_id, work_date)
  where action in ('confirmed', 'auto_confirmed', 'dispute_rejected');

-- Immutability: a settlement row is the employee's answer and can never be edited.
-- `applied_candidate_id`/`applied_at` are the one exception — the month-end bridge
-- stamps them once — so the trigger blocks DELETE outright and blocks any UPDATE
-- that changes anything else.
create or replace function public.phx_attendance_settlement_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attendance_settlements rows are immutable (attempted DELETE)'
      using errcode = 'restrict_violation';
  end if;

  if (new.digest_line_id, new.employee_hr_id, new.work_date, new.action, new.deduction_days,
      new.deduction_value, new.actor_hr_id, new.actor_role, new.reviewer_hr_id, new.reason,
      new.decided_at)
     is distinct from
     (old.digest_line_id, old.employee_hr_id, old.work_date, old.action, old.deduction_days,
      old.deduction_value, old.actor_hr_id, old.actor_role, old.reviewer_hr_id, old.reason,
      old.decided_at)
  then
    raise exception 'attendance_settlements rows are immutable (only applied_candidate_id/applied_at may be stamped)'
      using errcode = 'restrict_violation';
  end if;

  if old.applied_candidate_id is not null
     and new.applied_candidate_id is distinct from old.applied_candidate_id then
    raise exception 'attendance_settlements.applied_candidate_id is write-once'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_settlements_immutable on public.attendance_settlements;
create trigger attendance_settlements_immutable
  before update or delete on public.attendance_settlements
  for each row execute function public.phx_attendance_settlement_immutable();

-- ---------------------------------------------------------------------------
-- RLS + grants (service_role only)
-- ---------------------------------------------------------------------------
alter table public.attendance_digest_settings enable row level security;
alter table public.attendance_weekly_digests  enable row level security;
alter table public.attendance_digest_lines    enable row level security;
alter table public.attendance_settlements     enable row level security;

revoke all on table public.attendance_digest_settings from anon, authenticated;
revoke all on table public.attendance_weekly_digests  from anon, authenticated;
revoke all on table public.attendance_digest_lines    from anon, authenticated;
revoke all on table public.attendance_settlements     from anon, authenticated;

grant select, insert, update, delete on table public.attendance_digest_settings to service_role;
grant select, insert, update, delete on table public.attendance_weekly_digests  to service_role;
grant select, insert, update, delete on table public.attendance_digest_lines    to service_role;
-- Settlements: no delete grant, and update only so the bridge can stamp applied_*.
grant select, insert, update on table public.attendance_settlements to service_role;

grant usage, select on sequence public.attendance_weekly_digests_id_seq to service_role;
grant usage, select on sequence public.attendance_digest_lines_id_seq   to service_role;
grant usage, select on sequence public.attendance_settlements_id_seq    to service_role;

drop policy if exists attendance_digest_settings_service_role_all on public.attendance_digest_settings;
create policy attendance_digest_settings_service_role_all on public.attendance_digest_settings
  for all to service_role using (true) with check (true);

drop policy if exists attendance_weekly_digests_service_role_all on public.attendance_weekly_digests;
create policy attendance_weekly_digests_service_role_all on public.attendance_weekly_digests
  for all to service_role using (true) with check (true);

drop policy if exists attendance_digest_lines_service_role_all on public.attendance_digest_lines;
create policy attendance_digest_lines_service_role_all on public.attendance_digest_lines
  for all to service_role using (true) with check (true);

drop policy if exists attendance_settlements_service_role_all on public.attendance_settlements;
create policy attendance_settlements_service_role_all on public.attendance_settlements
  for all to service_role using (true) with check (true);

comment on table public.attendance_weekly_digests is
  'One weekly attendance digest per employee per settlement week (4 per 24->24 cycle). Rebuilt 2026-09-08.';
comment on table public.attendance_digest_lines is
  'Per-day deductible items inside a weekly digest; carries the employee confirm/dispute action and the evidence that could contradict the charge.';
comment on table public.attendance_settlements is
  'Immutable record of an employee''s answer to a flagged day. NOT a deduction: the month-end Fingerprint connector remains the only writer of deductions_candidates.';
comment on table public.attendance_digest_settings is
  'Singleton config for the weekly-digest engine: dispute reviewers, channels, auto-confirm window, cycle anchor, dry-run and enabled flags.';

notify pgrst, 'reload schema';

commit;
