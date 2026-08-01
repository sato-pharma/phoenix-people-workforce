-- Unified Deductions module — Phase 1: category config, candidate ledger, decisions.
--
-- Brand-new module; add-only, never touches the legacy `deduction_*` (singular)
-- tables owned by src/lib/deductions-governance/ — that module keeps running
-- unmodified until cutover. This module becomes the source of truth for every
-- payroll deduction (fingerprint, CRM, no-records-activity, unpaid vacation,
-- insufficient-balance vacation, loan, other); Phase 2 adds the monthly publish
-- snapshot (deductions_publications/deductions_publication_lines) that
-- Automated Payroll and the employee portal will eventually read exclusively.
--
-- RLS mirrors automated_payroll_*'s pattern (20260720100000_automated_payroll.sql):
-- service_role bypasses RLS; authenticated access gated by
-- public.current_access_can_manage_employees() (Super Admin / HR). No anon grant.
-- deductions_categories is plain reference data, readable by any authenticated user.

-- ---------------------------------------------------------------------------
-- deductions_categories — 7-row reference table, makes category behavior
-- data-driven instead of scattered if/else chains.
-- ---------------------------------------------------------------------------

create table if not exists public.deductions_categories (
  category            text primary key,
  label                text not null,
  detection_engine     text not null,
  requires_approval    boolean not null default true,
  salary_records_column text,
  sort_order           smallint not null default 0,
  constraint deductions_categories_category_check
    check (category in (
      'fingerprint', 'crm', 'no_records_activity', 'unpaid_vacation',
      'insufficient_balance_vacation', 'loan', 'other'
    )),
  constraint deductions_categories_salary_records_column_check
    check (salary_records_column is null or salary_records_column in (
      'finger_print', 'crm', 'unpaid_vacations', 'loans', 'other_deductions'
    ))
);

insert into public.deductions_categories (category, label, detection_engine, requires_approval, salary_records_column, sort_order)
values
  ('fingerprint', 'Fingerprint', 'fingerprint_report', true, 'finger_print', 1),
  ('crm', 'CRM', 'crm_visits_mirror', false, 'crm', 2),
  ('no_records_activity', 'No Records Activity', 'no_activity_engine', true, 'other_deductions', 3),
  ('unpaid_vacation', 'Unpaid Vacation', 'vacation_balance', true, 'unpaid_vacations', 4),
  ('insufficient_balance_vacation', 'Insufficient Balance Vacation', 'vacation_balance', true, 'unpaid_vacations', 5),
  ('loan', 'Loan', 'manual_hr', true, 'loans', 6),
  ('other', 'Other', 'manual_hr', true, 'other_deductions', 7)
on conflict (category) do nothing;

comment on table public.deductions_categories is
  'Unified Deductions module: the 7 category definitions (label, detection engine, whether a decision is required before payroll approval, which salary_records column it ultimately maps to).';
comment on column public.deductions_categories.requires_approval is
  'false only for crm — the owner''s existing dictated rule: a field rep''s no-CRM-activity day is deducted by default unless HR explicitly clears it.';

-- ---------------------------------------------------------------------------
-- deductions_candidates — the ledger. Mutable while unlocked (legitimizes
-- refreshing a live, undecided candidate as new source data streams in);
-- hard-immutable once a publish captures it (see guard trigger below).
-- ---------------------------------------------------------------------------

create table if not exists public.deductions_candidates (
  id                         uuid primary key default gen_random_uuid(),
  category                   text not null references public.deductions_categories(category),
  source_system              text not null,
  source_record_id           text not null,
  candidate_key              text not null,
  employee_hr_id             text not null,
  employee_hr_id_compact     text not null,
  employee_name              text,
  month                      integer not null,
  year                       integer not null,
  month_key                  text generated always as (year::text || '-' || lpad(month::text, 2, '0')) stored,
  unit                       text not null,
  raw_value                  numeric(14, 2) not null default 0,
  estimated_amount           numeric(14, 2),
  calculation_status         text not null default 'requires_review',
  severity                   text,
  reason                     text,
  evidence                   jsonb not null default '{}'::jsonb,
  dates                      jsonb not null default '[]'::jsonb,
  hierarchy_snapshot         jsonb not null default '{}'::jsonb,
  created_by                 text not null default 'system',
  created_at                 timestamptz not null default now(),
  refreshed_at               timestamptz,
  locked_at                  timestamptz,
  superseded_at              timestamptz,
  superseded_by_candidate_id uuid references public.deductions_candidates(id) on delete set null,
  constraint deductions_candidates_source_record_id_not_blank check (btrim(source_record_id) <> ''),
  constraint deductions_candidates_candidate_key_not_blank check (btrim(candidate_key) <> ''),
  constraint deductions_candidates_employee_hr_id_not_blank check (btrim(employee_hr_id) <> ''),
  constraint deductions_candidates_employee_hr_id_compact_not_blank check (btrim(employee_hr_id_compact) <> ''),
  constraint deductions_candidates_month_range check (month >= 1 and month <= 12),
  constraint deductions_candidates_year_range check (year >= 2000 and year <= 2100),
  constraint deductions_candidates_unit_check check (unit in ('days', 'amount')),
  constraint deductions_candidates_raw_value_non_negative check (raw_value >= 0),
  constraint deductions_candidates_estimated_amount_non_negative check (estimated_amount is null or estimated_amount >= 0),
  constraint deductions_candidates_calculation_status_check check (calculation_status in ('calculated', 'requires_review')),
  constraint deductions_candidates_severity_check check (severity is null or severity in ('Low', 'Medium', 'High', 'Review'))
);

comment on table public.deductions_candidates is
  'Unified Deductions module: immutable-once-published ledger of deduction candidates. Governance/reporting layer only — no trigger or application path writes salary_records/salary_batches from this table; Automated Payroll only ever reads a Phase-2 published snapshot.';
comment on column public.deductions_candidates.locked_at is
  'Set by the Phase-2 publish RPC when this candidate is captured into a snapshot. While NULL, raw_value/estimated_amount/evidence/dates may be refreshed in place as source data changes. Once set, the guard trigger below rejects further value mutation — correct it by superseding (new row + superseded_at/superseded_by_candidate_id on this one), never by editing a published number.';

-- At most one live (non-superseded) candidate per category+candidate_key.
create unique index if not exists deductions_candidates_live_key_idx
  on public.deductions_candidates (category, candidate_key)
  where superseded_at is null;
create index if not exists deductions_candidates_employee_idx
  on public.deductions_candidates (employee_hr_id_compact);
create index if not exists deductions_candidates_month_key_idx
  on public.deductions_candidates (month_key);
create index if not exists deductions_candidates_category_month_idx
  on public.deductions_candidates (category, month_key);
create index if not exists deductions_candidates_superseded_by_idx
  on public.deductions_candidates (superseded_by_candidate_id);
create index if not exists deductions_candidates_dates_gin_idx
  on public.deductions_candidates using gin (dates jsonb_path_ops);

-- Guard trigger: once locked_at is set, the substantive fields of a candidate
-- can no longer be mutated in place — only supersession (a new row, plus
-- superseded_at/superseded_by_candidate_id/refreshed_at on this one, all of
-- which remain writable regardless of lock state) can change a published number.
create or replace function public.deductions_candidates_guard_locked()
returns trigger
language plpgsql
as $$
begin
  if old.locked_at is not null then
    if new.raw_value is distinct from old.raw_value
      or new.estimated_amount is distinct from old.estimated_amount
      or new.unit is distinct from old.unit
      or new.calculation_status is distinct from old.calculation_status
      or new.severity is distinct from old.severity
      or new.reason is distinct from old.reason
      or new.evidence is distinct from old.evidence
      or new.dates is distinct from old.dates
      or new.hierarchy_snapshot is distinct from old.hierarchy_snapshot
    then
      raise exception
        'deductions_candidates: candidate % is locked (locked_at=%) by a publication — supersede it with a new row instead of mutating it',
        old.id, old.locked_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists deductions_candidates_guard_locked_trg on public.deductions_candidates;
create trigger deductions_candidates_guard_locked_trg
  before update on public.deductions_candidates
  for each row execute function public.deductions_candidates_guard_locked();

-- ---------------------------------------------------------------------------
-- deductions_decisions — 1:1 with a candidate. Payroll-deductions only (no
-- leave-balance-adjustment status — out of scope for this module); no
-- export/handoff bookkeeping (the Phase-2 publication *is* the handoff).
-- ---------------------------------------------------------------------------

create table if not exists public.deductions_decisions (
  id                     uuid primary key default gen_random_uuid(),
  candidate_id           uuid not null unique references public.deductions_candidates(id) on delete cascade,
  decision_status        text not null default 'Pending',
  decision_reason        text not null default '',
  hr_note                text not null default '',
  applied_value          numeric(14, 2),
  applied_amount         numeric(14, 2),
  decided_by             text,
  decided_at             timestamptz,
  actor_role_at_decision text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint deductions_decisions_status_check
    check (decision_status in ('Pending', 'Approved for Payroll', 'Do Not Take Action', 'Needs Follow-up', 'Disputed')),
  constraint deductions_decisions_reason_required_when_decided
    check (decision_status = 'Pending' or btrim(decision_reason) <> ''),
  constraint deductions_decisions_applied_value_non_negative
    check (applied_value is null or applied_value >= 0),
  constraint deductions_decisions_applied_amount_non_negative
    check (applied_amount is null or applied_amount >= 0)
);

comment on table public.deductions_decisions is
  'Unified Deductions module: one HR decision per candidate. Super Admin gated (mirrors assertDeductionsGovernanceDecisionActor / assertAutomatedPayrollHrActor). Feeds the Phase-2 publish snapshot only — never writes payroll tables directly.';

create index if not exists deductions_decisions_status_idx
  on public.deductions_decisions (decision_status);

create or replace function public.deductions_decisions_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists deductions_decisions_touch_updated_at_trg on public.deductions_decisions;
create trigger deductions_decisions_touch_updated_at_trg
  before update on public.deductions_decisions
  for each row execute function public.deductions_decisions_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — service_role bypasses RLS; authenticated gated by
-- current_access_can_manage_employees() (Super Admin / HR), mirroring
-- automated_payroll_*. deductions_categories is plain reference data.
-- ---------------------------------------------------------------------------

alter table public.deductions_categories enable row level security;
alter table public.deductions_candidates enable row level security;
alter table public.deductions_decisions  enable row level security;

drop policy if exists deductions_categories_authenticated_select on public.deductions_categories;
create policy deductions_categories_authenticated_select
  on public.deductions_categories for select to authenticated
  using (true);

do $$
declare
  target_table text;
  targets text[] := array[
    'deductions_candidates',
    'deductions_decisions'
  ];
begin
  foreach target_table in array targets loop
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_select', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_insert', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_update', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_delete', target_table);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_access_can_manage_employees())',
      target_table || '_admin_select', target_table);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.current_access_can_manage_employees())',
      target_table || '_admin_insert', target_table);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.current_access_can_manage_employees()) with check (public.current_access_can_manage_employees())',
      target_table || '_admin_update', target_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.current_access_can_manage_employees())',
      target_table || '_admin_delete', target_table);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants — no anon; authenticated is RLS-gated; service_role full.
-- ---------------------------------------------------------------------------

do $$
declare
  target_table text;
  targets text[] := array[
    'deductions_categories',
    'deductions_candidates',
    'deductions_decisions'
  ];
begin
  foreach target_table in array targets loop
    execute format('revoke all on table public.%I from anon', target_table);
    execute format('revoke all on table public.%I from public', target_table);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', target_table);
    execute format('grant all on table public.%I to service_role', target_table);
  end loop;
end $$;
