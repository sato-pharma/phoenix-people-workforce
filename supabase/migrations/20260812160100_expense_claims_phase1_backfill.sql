-- Outstation & Expenses — Target Architecture, PHASE 1: backfill.
--
-- Writes ONLY into the four tables phase 0 created. Reads the legacy tables; changes none of them.
-- Idempotent WHILE the legacy tables are still the source of truth: it clears the new tables first,
-- so it can be re-run freely during phases 1-2. After the phase 3 cutover the interlock below
-- refuses it outright, because a rebuild would destroy natively created claims.
-- Reversing it is `delete from expense_claims` (events cascade).
--
-- MERGE RULE (matches the application's own `listUnifiedOutstationExpenses` /
-- `carryStoredDecisionOntoRequestExpenses`): where a trip exists in BOTH tables, the REQUEST is
-- authoritative for identity, trip and status, and the ledger row supplies only the two things the
-- request cannot store - the approved figure and who decided it, when.
--
-- Expected result, measured on production 2026-08-12:
--   39 requests + 360 ledger rows - 24 overlapping = 375 claims
--
-- CLAIMED TOTAL: uses the same formula the money already follows
-- (`outstationExpenseTotal`: claimed when > 0, else expected), so a claim's total here is exactly
-- what payroll would have paid. 7 rows are flagged `data_quality_hold` rather than silently
-- reconciled: 6 whose COMPONENTS do not sum to that total (incl. the two the owner deferred on
-- 2026-08-12), plus TRP-00285, which is Rejected while still carrying an approver. Nothing is
-- invented and no legacy row is altered.

begin;

-- Idempotent reset (new tables only).
-- SAFETY INTERLOCK (same rule as phx_refresh_expense_claims in phase 2).
-- This migration rebuilds from the legacy tables, which is correct while they are still the source
-- of truth. Once phase 3 cuts writes over, a claim exists with no legacy ancestor and a rebuild
-- would DESTROY it. A migration that has already run is normally never re-run - but a fresh
-- environment, a `db push`, or a hand re-run would, so the guard lives in the file itself.
do $$
declare v_native integer;
begin
  select count(*) into v_native
  from public.expense_claims
  where legacy_request_id is null and legacy_expense_id is null;

  if v_native > 0 then
    raise exception
      'Refusing to backfill: % claim(s) have no legacy link, so writes have already cut over. '
      'This PHASE 1 migration is not safe to re-run.', v_native
      using errcode = 'P0001';
  end if;
end $$;

delete from public.expense_claim_events;
delete from public.expense_payroll_links;
delete from public.expense_claims;
delete from public.expense_imports;

-- ── 1. Real uploaded files only. The 36 `.workflow` synthetics are NOT imports. ──────────────
insert into public.expense_imports (file_name, uploaded_at, legacy_report_id)
select e.source_file_name,
       min(r.created_at),
       (array_agg(r.id order by r.created_at))[1]
from public.outstation_expenses e
left join public.outstation_expense_reports r
       on r.id = e.report_id and r.file_name = e.source_file_name
where e.source_file_name not like '%.workflow'
  and btrim(coalesce(e.source_file_name, '')) <> ''
group by e.source_file_name;

-- ── 2. Claims from REQUESTS (authoritative side of the merge) ────────────────────────────────
insert into public.expense_claims (
  claim_ref, employee_hr_id, employee_name, employee_role, line_name, area_name,
  source, status, transportation_type, expense_type,
  trip_start_date, trip_end_date, destination_label, distance_km,
  fuel_amount, allowance_amount, ticket_go_amount, ticket_return_amount,
  meeting_amount, other_amount, claimed_total, approved_total,
  decided_by_hr_id, decided_at, decision_reason,
  incurred_year, incurred_month, payout_year, payout_month,
  evidence_gate_status, workload_gate_status,
  legacy_request_id, legacy_expense_id, created_at
)
select
  'OUTSTATION-' || r.id,
  r.employee_hr_id,
  r.employee_name,
  r.employee_role,
  r.line,
  r.area,
  case when adm.entity_id is not null then 'admin_manual' else 'wizard' end,
  case
    when r.status like 'rejected%' then 'rejected'
    when r.status like 'accepted%' or r.status = 'approved' then 'approved'
    else 'submitted'
  end,
  r.transportation_type,
  r.expense_type,
  r.trip_start_date,
  r.trip_end_date,
  coalesce(r.to_label, r.to_city, r.to_area),
  r.distance_from_residence_km,
  r.fuel_amount, r.allowance_amount, r.go_ticket_amount, r.return_ticket_amount,
  r.meeting_amount, r.other_amount,
  case when r.claimed_total_amount > 0 then r.claimed_total_amount else r.expected_total_amount end,
  -- Only an approved claim carries an approved figure; it comes from the linked ledger row.
  case when (r.status like 'accepted%' or r.status = 'approved')
       then coalesce(e.approved_amount, e.total) end,
  case when (r.status like 'accepted%' or r.status = 'approved') then e.approved_by end,
  case when (r.status like 'accepted%' or r.status = 'approved') then e.approved_at end,
  nullif(btrim(coalesce(r.approval_reason, '')), ''),
  extract(year  from r.trip_start_date)::int,
  extract(month from r.trip_start_date)::int,
  case when (r.status like 'accepted%' or r.status = 'approved') then e.payout_year end,
  case when (r.status like 'accepted%' or r.status = 'approved') then e.payout_month end,
  r.evidence_gate_status,
  r.workload_gate_status,
  r.id,
  e.id,
  r.created_at
from public.outstation_expense_requests r
left join public.outstation_expenses e on e.trip_id = 'OUTSTATION-' || r.id
left join (
  select distinct entity_id
  from public.audit_logs
  where entity_type = 'outstation_request' and summary ilike 'Admin created%'
) adm on adm.entity_id = r.id::text;

-- ── 3. Claims from LEDGER rows NOT shadowed by a request ─────────────────────────────────────
insert into public.expense_claims (
  claim_ref, employee_hr_id, employee_name, source, import_id, status,
  transportation_type, expense_type, trip_start_date, trip_end_date,
  destination_label, distance_km,
  fuel_amount, allowance_amount, meeting_amount, other_amount,
  claimed_total, approved_total,
  decided_by_hr_id, decided_at, decision_reason,
  incurred_year, incurred_month, payout_year, payout_month,
  legacy_expense_id, created_at
)
select
  e.trip_id,
  e.hr_id,
  coalesce(nullif(btrim(e.specialist), ''), e.hr_id),
  case when e.source_file_name like '%.workflow' then 'admin_manual' else 'import' end,
  imp.id,
  case
    when e.hr_approved then 'approved'
    when coalesce(e.status, '') ilike '%reject%' then 'rejected'
    else 'submitted'
  end,
  e.transportation_type,
  e.trip_type,
  e.expense_date::timestamptz,
  coalesce(e.to_date, e.expense_date)::timestamptz,
  coalesce(nullif(btrim(coalesce(e.to_location, '')), ''), e.location),
  e.km,
  e.travel_cost, e.allowance, e.meeting_amount, e.other_amount,
  e.total,
  case when e.hr_approved then coalesce(e.approved_amount, e.total) end,
  case when e.hr_approved then e.approved_by end,
  case when e.hr_approved then e.approved_at end,
  nullif(btrim(coalesce(e.hr_comment, '')), ''),
  extract(year  from e.expense_date)::int,
  extract(month from e.expense_date)::int,
  case when e.hr_approved then e.payout_year end,
  case when e.hr_approved then e.payout_month end,
  e.id,
  e.created_at
from public.outstation_expenses e
left join public.expense_imports imp
       on imp.file_name = e.source_file_name and e.source_file_name not like '%.workflow'
where not exists (
  select 1 from public.outstation_expense_requests r where 'OUTSTATION-' || r.id = e.trip_id
);

-- ── 4. Data-quality flags: surfaced, never silently reconciled ───────────────────────────────
update public.expense_claims c
set data_quality_hold = true,
    data_quality_reason = 'Components do not sum to the claimed total (legacy). Owner deferred 2026-08-12.'
where abs(c.claimed_total - (c.fuel_amount + c.allowance_amount + c.ticket_go_amount
        + c.ticket_return_amount + c.meeting_amount + c.other_amount)) > 0.005;

update public.expense_claims c
set data_quality_hold = true,
    data_quality_reason = coalesce(c.data_quality_reason || ' | ', '')
      || 'Legacy row was Rejected while still carrying an approver.'
from public.outstation_expenses e
where e.id = c.legacy_expense_id
  and coalesce(e.status, '') = 'Rejected'
  and (e.approved_at is not null or e.approved_by is not null);

-- ── 5. One migration event per claim, carrying the legacy identifiers and the original
--       components, so the discrepancy is preserved and queryable rather than buried. ─────────
insert into public.expense_claim_events (claim_id, actor_hr_id, event_type, message, metadata)
select
  c.id,
  null,
  'migrated',
  'Backfilled from ' || case
    when c.legacy_request_id is not null and c.legacy_expense_id is not null
      then 'outstation_expense_requests + outstation_expenses (merged)'
    when c.legacy_request_id is not null then 'outstation_expense_requests'
    else 'outstation_expenses' end,
  jsonb_strip_nulls(jsonb_build_object(
    'legacy_request_id', c.legacy_request_id,
    'legacy_expense_id', c.legacy_expense_id,
    'source', c.source,
    'status', c.status,
    'claimed_total', c.claimed_total,
    'approved_total', c.approved_total,
    'component_sum', (c.fuel_amount + c.allowance_amount + c.ticket_go_amount
                      + c.ticket_return_amount + c.meeting_amount + c.other_amount),
    'data_quality_hold', case when c.data_quality_hold then true else null end,
    'data_quality_reason', c.data_quality_reason
  ))
from public.expense_claims c;

commit;
