-- Outstation & Expenses — Target Architecture, PHASE 0: schema only.
--
-- ADDITIVE ONLY. This migration creates four new tables and three views and touches
-- NOTHING that exists. No existing table is altered, no data is read or written, no
-- application code points at any of this yet. Dropping the four tables reverses it whole.
--
-- Design: OUTSTATION_EXPENSES_TARGET_ARCHITECTURE.md
-- Evidence: OUTSTATION_EXPENSES_AUDIT.md (33 findings) · OUTSTATION_EXPENSES_REAUDIT.md
--
-- What it replaces, once phases 2-3 cut over:
--   outstation_expense_requests + outstation_expenses  -> expense_claims   (ONE object, real FK)
--   outstation_expense_reports                         -> expense_imports  (real files only)
--   (nothing)                                          -> expense_claim_events   (F-06: the ledger
--                                                         has ZERO audit rows today)
--   imported_to_payroll_at / _by / _batch_id           -> expense_payroll_links (F-01/F-03/F-04)
--
-- Constraint policy for this phase: only invariants that ALL 399 legacy rows already satisfy are
-- enforced now, verified against production 2026-08-12. Two are deliberately NOT enforced yet and
-- are recorded as `data_quality_hold` at backfill instead, because production violates them:
--   * 1 ledger row is `Rejected` while still carrying approved_at/approved_by (TRP-00285)
--   * 2 ledger rows have components that do not sum to their total (OUTSTATION-31, OUTSTATION-52)
-- The second pair is deferred by owner ruling 2026-08-12; the generated-total constraint lands in
-- phase 6, not here.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. expense_imports — a REAL uploaded file. Never minted by the workflow.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.expense_imports (
  id                 uuid primary key default gen_random_uuid(),
  file_name          text        not null,
  uploaded_by_hr_id  text,
  uploaded_at        timestamptz not null default now(),
  -- traceability back to outstation_expense_reports during phases 1-5
  legacy_report_id   uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint expense_imports_file_name_not_blank check (btrim(file_name) <> ''),
  -- F-24: the ONLY reason 36 of 38 "Historical Uploads" are fake is that approving a request
  -- minted a report named `outstation-request-<id>.workflow`. Refuse that shape outright.
  constraint expense_imports_no_synthetic_workflow check (file_name not like '%.workflow')
);

comment on table public.expense_imports is
  'A genuine uploaded expense spreadsheet. Replaces outstation_expense_reports. Row counts and '
  'totals are NOT stored here - see v_expense_import_summary (F-14: 25 of 38 legacy headers were wrong).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. expense_claims — ONE row per claim, whatever door it came in through.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.expense_claims (
  id                    uuid primary key default gen_random_uuid(),

  -- Keeps TODAY's values ('OUTSTATION-57', 'TRP-00285') so every existing deep link, audit row,
  -- export and memory note still resolves. Verified unique across all 360 legacy ledger rows.
  claim_ref             text not null unique,

  employee_hr_id        text not null
                          references public.employees (hr_id)
                          on update cascade on delete restrict,
  employee_name         text not null default '',
  employee_role         text,
  line_name             text,
  area_name             text,

  source                text not null
                          check (source in ('wizard', 'admin_manual', 'import')),
  import_id             uuid references public.expense_imports (id) on delete set null,

  -- ONE status column, DB-enforced. Replaces nine representations across two tables
  -- (F-11, F-25). Every non-terminal state has a supported exit (F-10).
  status                text not null
                          check (status in ('submitted', 'returned', 'approved',
                                            'rejected', 'in_payroll', 'paid', 'cancelled')),

  -- trip
  transportation_type   text,
  expense_type          text,
  trip_start_date       timestamptz,
  trip_end_date         timestamptz,
  destination_label     text,
  distance_km           numeric(12, 2),

  -- amounts
  fuel_amount           numeric(12, 2) not null default 0,
  allowance_amount      numeric(12, 2) not null default 0,
  ticket_go_amount      numeric(12, 2) not null default 0,
  ticket_return_amount  numeric(12, 2) not null default 0,
  meeting_amount        numeric(12, 2) not null default 0,
  other_amount          numeric(12, 2) not null default 0,
  -- Plain column in phases 1-5; becomes GENERATED in phase 6 once the two deferred rows are ruled
  -- on. See OUTSTATION_EXPENSES_TARGET_ARCHITECTURE.md section 13.
  claimed_total         numeric(12, 2) not null default 0,
  -- F-32: written on EVERY approval, even when it equals the claim, so "reviewed and approved in
  -- full" stops being indistinguishable from "nobody touched it".
  approved_total        numeric(12, 2),
  data_quality_hold     boolean not null default false,
  data_quality_reason   text,

  -- decision
  decided_by_hr_id      text,
  decided_at            timestamptz,
  decision_reason       text,

  -- WHEN the expense happened. Derived from the trip; never moves. Reporting uses this.
  incurred_year         integer,
  incurred_month        integer,
  -- WHICH payroll pays it. NULL until approved, then resolved to the earliest OPEN period.
  -- 241 backlog claims sit in periods whose batch is locked, and the salary_records trigger
  -- phx_prevent_closed_salary_detail_mutation refuses those writes outright.
  payout_year           integer,
  payout_month          integer,

  -- gates stay orthogonal to status: approval and payment are deliberately separate
  evidence_gate_status  text,
  workload_gate_status  text,

  -- legacy traceability, dropped in phase 6
  legacy_request_id     bigint,
  legacy_expense_id     uuid,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint expense_claims_claim_ref_not_blank check (btrim(claim_ref) <> ''),
  constraint expense_claims_amounts_non_negative check (
    fuel_amount >= 0 and allowance_amount >= 0 and ticket_go_amount >= 0
    and ticket_return_amount >= 0 and meeting_amount >= 0 and other_amount >= 0
    and claimed_total >= 0
  ),
  -- F-33: production has no upper bound on an approved figure today. 0 legacy violations.
  constraint expense_claims_approved_total_range check (
    approved_total is null or (approved_total >= 0 and approved_total <= claimed_total)
  ),
  -- Verified safe: all 3 approved requests and all 82 approved ledger rows carry a timestamp.
  constraint expense_claims_approved_needs_decision check (
    status <> 'approved' or decided_at is not null
  ),
  constraint expense_claims_incurred_month_valid check (
    incurred_month is null or incurred_month between 1 and 12
  ),
  constraint expense_claims_payout_month_valid check (
    payout_month is null or payout_month between 1 and 12
  ),
  -- import_id is meaningful only for an imported claim
  constraint expense_claims_import_id_only_for_import check (
    import_id is null or source = 'import'
  )
);

create index if not exists expense_claims_employee_idx      on public.expense_claims (lower(employee_hr_id));
create index if not exists expense_claims_status_idx        on public.expense_claims (status);
create index if not exists expense_claims_payout_period_idx on public.expense_claims (payout_year, payout_month);
create index if not exists expense_claims_incurred_idx      on public.expense_claims (incurred_year, incurred_month);
create index if not exists expense_claims_import_idx        on public.expense_claims (import_id);

comment on table public.expense_claims is
  'ONE row per outstation expense claim, whether captured in the wizard, entered by an admin, or '
  'imported from a spreadsheet. Replaces outstation_expense_requests + outstation_expenses, which '
  'were joined only by the STRING ''OUTSTATION-'' || id with no foreign key.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. expense_claim_events — append-only. Mirrors direct_order_events.
--    F-06: audit_logs holds 116 rows for outstation_request and ZERO for the ledger,
--    which is the table the money is actually read from.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.expense_claim_events (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references public.expense_claims (id) on delete cascade,
  actor_hr_id   text,
  event_type    text not null,
  message       text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint expense_claim_events_type_not_blank check (btrim(event_type) <> '')
);

create index if not exists expense_claim_events_claim_idx   on public.expense_claim_events (claim_id, created_at desc);
create index if not exists expense_claim_events_type_idx    on public.expense_claim_events (event_type);

comment on table public.expense_claim_events is
  'Append-only history for one claim. Written INSIDE the decision transaction, so an unaudited '
  'money mutation is not possible rather than merely discouraged.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. expense_payroll_links — the ONLY payroll contract.
--    UNIQUE(claim_id) makes re-running an import a no-op (F-01), and the write that
--    accompanies it is ADDITIVE, so the EGP 19,354/month of non-outstation expenses
--    can never be zeroed the way phx_import_approved_expenses_to_payroll would (F-03).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.expense_payroll_links (
  id                uuid primary key default gen_random_uuid(),
  claim_id          uuid not null unique
                      references public.expense_claims (id) on delete restrict,
  salary_batch_id   uuid not null references public.salary_batches (id) on delete restrict,
  salary_record_id  uuid,
  amount            numeric(12, 2) not null,
  linked_at         timestamptz not null default now(),
  linked_by_hr_id   text,
  created_at        timestamptz not null default now(),
  constraint expense_payroll_links_amount_non_negative check (amount >= 0)
);

create index if not exists expense_payroll_links_batch_idx on public.expense_payroll_links (salary_batch_id);

comment on table public.expense_payroll_links is
  'Which claim paid which salary record, for how much. Replaces outstation_expenses.'
  'imported_to_payroll_at, which is NULL on all 360 legacy rows and structurally unreachable - '
  'the reason every paid employee is still told "Not yet pulled into a payroll batch" (F-04).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. updated_at maintained by TRIGGER, not by the application clock.
--    F-27: 37 of 38 legacy report rows are "updated" BEFORE they were created.
-- ─────────────────────────────────────────────────────────────────────────────
drop trigger if exists expense_claims_touch_updated_at on public.expense_claims;
create trigger expense_claims_touch_updated_at
  before update on public.expense_claims
  for each row execute function public.touch_updated_at();

drop trigger if exists expense_imports_touch_updated_at on public.expense_imports;
create trigger expense_imports_touch_updated_at
  before update on public.expense_imports
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Derived values are COMPUTED, never stored (F-14, F-17, F-27).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.v_expense_import_summary as
select
  i.id                                              as import_id,
  i.file_name,
  i.uploaded_at,
  count(c.id)                                       as row_count,
  count(c.id) filter (where c.status = 'approved')  as approved_rows,
  coalesce(sum(c.claimed_total), 0)::numeric(14, 2) as total_claimed,
  coalesce(sum(c.approved_total), 0)::numeric(14, 2) as total_approved,
  min(c.trip_start_date)                            as trip_date_from,
  max(c.trip_end_date)                              as trip_date_to
from public.expense_imports i
left join public.expense_claims c on c.import_id = i.id
group by i.id, i.file_name, i.uploaded_at;

comment on view public.v_expense_import_summary is
  'Live replacement for outstation_expense_reports.row_count / approved_rows / total_expenses, '
  'which had no trigger and were wrong on 25 of 38 rows.';

-- What payroll may pull: approved, both gates clear, not already linked.
create or replace view public.v_expense_payable as
select
  c.payout_year,
  c.payout_month,
  c.employee_hr_id,
  lower(c.employee_hr_id)                                        as employee_hr_id_key,
  count(*)                                                       as claim_count,
  sum(coalesce(c.approved_total, c.claimed_total))::numeric(14, 2) as payable_amount
from public.expense_claims c
where c.status = 'approved'
  and c.payout_year is not null
  and c.payout_month is not null
  and coalesce(c.evidence_gate_status, 'complete') in ('complete', 'grandfathered')
  and coalesce(c.workload_gate_status, 'complete') in ('complete', 'grandfathered', 'manual')
  and not exists (select 1 from public.expense_payroll_links l where l.claim_id = c.id)
group by c.payout_year, c.payout_month, c.employee_hr_id;

comment on view public.v_expense_payable is
  'The payroll contract. Payroll PULLS this; Outstation never writes to salary_records.';

-- The report this whole phase exists to produce: approved vs actually paid, per month.
create or replace view public.v_expense_payroll_reconciliation as
with claimed as (
  select c.incurred_year as yr, c.incurred_month as mo,
         count(*)                                                        as claims,
         count(*) filter (where c.status = 'approved')                   as approved_claims,
         count(*) filter (where c.status = 'rejected')                   as rejected_claims,
         count(*) filter (where c.status = 'submitted')                  as open_claims,
         sum(c.claimed_total)::numeric(14, 2)                            as claimed_egp,
         sum(coalesce(c.approved_total, 0))
           filter (where c.status in ('approved', 'in_payroll', 'paid'))::numeric(14, 2) as approved_egp
  from public.expense_claims c
  where c.incurred_year is not null
  group by 1, 2
),
linked as (
  select c.incurred_year as yr, c.incurred_month as mo,
         count(*)                          as linked_claims,
         sum(l.amount)::numeric(14, 2)     as linked_egp
  from public.expense_payroll_links l
  join public.expense_claims c on c.id = l.claim_id
  group by 1, 2
)
select coalesce(cl.yr, lk.yr)                              as incurred_year,
       coalesce(cl.mo, lk.mo)                              as incurred_month,
       cl.claims, cl.approved_claims, cl.rejected_claims, cl.open_claims,
       cl.claimed_egp, cl.approved_egp,
       coalesce(lk.linked_claims, 0)                       as linked_claims,
       coalesce(lk.linked_egp, 0)::numeric(14, 2)          as linked_egp,
       (coalesce(cl.approved_egp, 0) - coalesce(lk.linked_egp, 0))::numeric(14, 2)
                                                           as approved_not_yet_linked_egp
from claimed cl
full join linked lk on lk.yr = cl.yr and lk.mo = cl.mo;

comment on view public.v_expense_payroll_reconciliation is
  'Per incurred month: what was claimed, what was approved, and what payroll actually carried. '
  'The gap column is what the July 2026 hand-carry lost (EGP 2,354 across B-175 and B-74).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Security posture: match the module, and match production's own hardening.
--    The app connects as service_role; RLS is defence in depth. anon/authenticated
--    are never granted - see 20260809130000 / 20260809170000 for why.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.expense_claims        enable row level security;
alter table public.expense_claim_events  enable row level security;
alter table public.expense_payroll_links enable row level security;
alter table public.expense_imports       enable row level security;

drop policy if exists expense_claims_service_role_all on public.expense_claims;
create policy expense_claims_service_role_all on public.expense_claims
  for all to service_role using (true) with check (true);

drop policy if exists expense_claim_events_service_role_all on public.expense_claim_events;
create policy expense_claim_events_service_role_all on public.expense_claim_events
  for all to service_role using (true) with check (true);

drop policy if exists expense_payroll_links_service_role_all on public.expense_payroll_links;
create policy expense_payroll_links_service_role_all on public.expense_payroll_links
  for all to service_role using (true) with check (true);

drop policy if exists expense_imports_service_role_all on public.expense_imports;
create policy expense_imports_service_role_all on public.expense_imports
  for all to service_role using (true) with check (true);

revoke all on public.expense_claims, public.expense_claim_events,
              public.expense_payroll_links, public.expense_imports
  from anon, authenticated;

grant select, insert, update, delete on
  public.expense_claims, public.expense_claim_events,
  public.expense_payroll_links, public.expense_imports
  to service_role;

revoke all on public.v_expense_import_summary, public.v_expense_payable,
              public.v_expense_payroll_reconciliation
  from anon, authenticated;

grant select on public.v_expense_import_summary, public.v_expense_payable,
                public.v_expense_payroll_reconciliation
  to service_role;
