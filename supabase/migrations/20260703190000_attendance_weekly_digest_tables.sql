-- Weekly attendance digest + self-settlement data model.
--
-- Supports the confirmed flow: four weekly digests per 24->24 cycle, each showing
-- the deductible days (with EGP value); the employee confirms or disputes; silence
-- for 48h auto-confirms; confirmed/auto-confirmed deductions are salary-only and
-- flow to payroll governance; disputes go to HR + System Admin (cc manager + CEO).
--
-- Tables:
--   attendance_weekly_digests   — one row per (employee, cycle, week 1-4)
--   attendance_digest_lines     — one row per deductible day inside a digest
--   attendance_settlements      — IMMUTABLE audit ledger of every final outcome
--   attendance_digest_settings  — singleton config (approvers, verifier, timings)
--
-- All tables are service_role-only (RLS + explicit grant revoke), matching the
-- rest of the attendance module. The Phoenix app reaches them only through the
-- server-side admin client.

begin;

-- ---------------------------------------------------------------------------
-- Config singleton
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_digest_settings (
  id                          smallint primary key default 1 check (id = 1),
  approver_hr_ids             text[]      not null default '{}',
  cc_manager                  boolean     not null default true,
  cc_ceo                      boolean     not null default true,
  missing_punch_verifier_hr_id text       null,
  auto_confirm_hours          integer     not null default 48 check (auto_confirm_hours > 0),
  cycle_anchor_day            smallint    not null default 24 check (cycle_anchor_day between 1 and 28),
  dry_run                     boolean     not null default true,
  updated_at                  timestamptz not null default now(),
  updated_by                  text        null
);
insert into public.attendance_digest_settings (id) values (1)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Weekly digest (one per employee per settlement week)
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_weekly_digests (
  id                    bigserial primary key,
  employee_hr_id        text        not null,
  cycle_key             text        not null,               -- e.g. '2026-07' = 24 Jun -> 24 Jul cycle
  week_index            smallint    not null check (week_index between 1 and 4),
  week_start            date        not null,
  week_end              date        not null,
  status                text        not null default 'draft'
                        check (status in ('draft', 'sent', 'settled', 'auto_confirmed', 'void')),
  channels              jsonb       not null default '{}'::jsonb,   -- delivery/read record per channel
  sent_at               timestamptz null,
  auto_confirm_at       timestamptz null,                    -- sent_at + auto_confirm_hours
  total_deduction_days  numeric(8,3) not null default 0,
  total_deduction_value numeric(12,2) not null default 0,
  currency              text        not null default 'EGP',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (employee_hr_id, cycle_key, week_index)
);
create index if not exists attendance_weekly_digests_employee_idx
  on public.attendance_weekly_digests (employee_hr_id, cycle_key);
create index if not exists attendance_weekly_digests_status_idx
  on public.attendance_weekly_digests (status)
  where status in ('sent', 'draft');
create index if not exists attendance_weekly_digests_auto_confirm_idx
  on public.attendance_weekly_digests (auto_confirm_at)
  where status = 'sent';

-- ---------------------------------------------------------------------------
-- Digest lines (one per deductible day)
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_digest_lines (
  id                    bigserial primary key,
  digest_id             bigint      not null references public.attendance_weekly_digests(id) on delete cascade,
  work_date             date        not null,
  status                text        not null
                        check (status in ('late', 'short_hours', 'missing_punch')),
  late_minutes          integer     not null default 0,
  short_minutes         integer     not null default 0,
  worked_minutes        integer     not null default 0,
  deduction_days        numeric(8,3) not null default 0,
  deduction_value       numeric(12,2) not null default 0,
  reason                text        null,
  action                text        not null default 'pending'
                        check (action in ('pending', 'confirmed', 'disputed', 'auto_confirmed')),
  acted_at              timestamptz null,
  dispute_reason        text        null,
  dispute_attachment_url text       null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (digest_id, work_date)
);
create index if not exists attendance_digest_lines_digest_idx
  on public.attendance_digest_lines (digest_id);

-- ---------------------------------------------------------------------------
-- Settlement ledger (IMMUTABLE — the permanent record)
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_settlements (
  id                bigserial primary key,
  digest_line_id    bigint      not null references public.attendance_digest_lines(id),
  employee_hr_id    text        not null,
  work_date         date        not null,
  action            text        not null
                    check (action in ('confirmed', 'auto_confirmed', 'dispute_upheld', 'dispute_rejected')),
  deduction_days    numeric(8,3) not null default 0,
  deduction_value   numeric(12,2) not null default 0,
  actor_hr_id       text        null,                 -- who acted; null = system (auto-confirm)
  actor_role        text        null,
  reviewer_hr_id    text        null,                 -- dispute reviewer, when applicable
  reason            text        null,
  delivery          jsonb       not null default '{}'::jsonb,
  candidate_key     text        null,                 -- link to deduction_candidates governance
  decided_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index if not exists attendance_settlements_employee_idx
  on public.attendance_settlements (employee_hr_id, work_date);
-- Double-deduction guard: a given employee-day can be settled with a real
-- deduction at most once, across confirm / auto-confirm / upheld-dispute.
create unique index if not exists attendance_settlements_no_double_deduction_idx
  on public.attendance_settlements (employee_hr_id, work_date)
  where action in ('confirmed', 'auto_confirmed', 'dispute_upheld');

-- Immutability: settlement rows can never be updated or deleted.
create or replace function public.phx_attendance_settlement_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'attendance_settlements rows are immutable (attempted %)', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists attendance_settlements_immutable on public.attendance_settlements;
create trigger attendance_settlements_immutable
  before update or delete on public.attendance_settlements
  for each row execute function public.phx_attendance_settlement_immutable();

-- ---------------------------------------------------------------------------
-- RLS + grants (service_role only, matching the rest of the module)
-- ---------------------------------------------------------------------------
alter table public.attendance_digest_settings enable row level security;
alter table public.attendance_weekly_digests   enable row level security;
alter table public.attendance_digest_lines     enable row level security;
alter table public.attendance_settlements       enable row level security;

revoke all on table public.attendance_digest_settings from anon, authenticated;
revoke all on table public.attendance_weekly_digests   from anon, authenticated;
revoke all on table public.attendance_digest_lines     from anon, authenticated;
revoke all on table public.attendance_settlements       from anon, authenticated;

grant select, insert, update, delete on table public.attendance_digest_settings to service_role;
grant select, insert, update, delete on table public.attendance_weekly_digests   to service_role;
grant select, insert, update, delete on table public.attendance_digest_lines     to service_role;
-- Settlements: no update/delete grant either (belt-and-suspenders with the trigger).
grant select, insert on table public.attendance_settlements to service_role;

grant usage, select on sequence public.attendance_weekly_digests_id_seq to service_role;
grant usage, select on sequence public.attendance_digest_lines_id_seq   to service_role;
grant usage, select on sequence public.attendance_settlements_id_seq     to service_role;

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
  'One weekly attendance digest per employee per settlement week (4 per 24->24 cycle).';
comment on table public.attendance_digest_lines is
  'Per-day deductible items inside a weekly digest; carries the employee confirm/dispute action.';
comment on table public.attendance_settlements is
  'Immutable ledger of final attendance settlement outcomes. Rows cannot be updated or deleted.';
comment on table public.attendance_digest_settings is
  'Singleton config for the weekly-digest engine: approvers, missing-punch verifier, auto-confirm window, cycle anchor, dry-run.';

notify pgrst, 'reload schema';

commit;
