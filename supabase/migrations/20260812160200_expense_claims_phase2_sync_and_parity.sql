-- Outstation & Expenses — Target Architecture, PHASE 2: sync + parity.
--
-- Phase 2 runs the two models side by side. Writes still go to the LEGACY tables; this migration
-- adds the two things that makes that safe to observe:
--
--   1. phx_refresh_expense_claims()  - rebuilds expense_claims from the legacy tables. Idempotent,
--      so it can run as often as you like. Deliberately NOT a trigger: a trigger on
--      outstation_expense_requests / outstation_expenses would put new code inside the live write
--      path, and a failure there would block a real employee's submission. Phase 2 is supposed to
--      be observable, not load-bearing.
--
--   2. v_expense_claims_parity  - a live, per-claim diff of the new model against the legacy rows.
--      Agreement becomes provable on demand instead of assumed.
--
-- SAFETY INTERLOCK: the refresh does a full rebuild, which is correct while the legacy tables are
-- still the source of truth. The moment phase 3 starts writing claims natively, a full rebuild
-- would destroy them - so the function REFUSES to run if it finds a claim with no legacy link.
--
-- Additive only. Reversing it is dropping one function and one view.

create or replace function public.phx_refresh_expense_claims()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_native_claims integer;
  v_claims        integer;
  v_imports       integer;
  v_flagged       integer;
begin
  -- Phase-3 interlock. A natively created claim has no legacy ancestor; rebuilding would delete it.
  select count(*) into v_native_claims
  from public.expense_claims
  where legacy_request_id is null and legacy_expense_id is null;

  if v_native_claims > 0 then
    raise exception
      'Refusing to rebuild: % claim(s) have no legacy link, so they were created natively. '
      'phx_refresh_expense_claims is a PHASE 2 tool and is unsafe once writes have cut over.',
      v_native_claims
      using errcode = 'P0001';
  end if;

  delete from public.expense_claim_events;
  delete from public.expense_payroll_links;
  delete from public.expense_claims;
  delete from public.expense_imports;

  insert into public.expense_imports (file_name, uploaded_at, legacy_report_id)
  select e.source_file_name, min(r.created_at), (array_agg(r.id order by r.created_at))[1]
  from public.outstation_expenses e
  left join public.outstation_expense_reports r
         on r.id = e.report_id and r.file_name = e.source_file_name
  where e.source_file_name not like '%.workflow'
    and btrim(coalesce(e.source_file_name, '')) <> ''
  group by e.source_file_name;

  insert into public.expense_claims (
    claim_ref, employee_hr_id, employee_name, employee_role, line_name, area_name,
    source, status, transportation_type, expense_type, trip_start_date, trip_end_date,
    destination_label, distance_km, fuel_amount, allowance_amount, ticket_go_amount,
    ticket_return_amount, meeting_amount, other_amount, claimed_total, approved_total,
    decided_by_hr_id, decided_at, decision_reason, incurred_year, incurred_month,
    payout_year, payout_month, evidence_gate_status, workload_gate_status,
    legacy_request_id, legacy_expense_id, created_at)
  select 'OUTSTATION-' || r.id, r.employee_hr_id, r.employee_name, r.employee_role, r.line, r.area,
    case when adm.entity_id is not null then 'admin_manual' else 'wizard' end,
    case when r.status like 'rejected%' then 'rejected'
         when r.status like 'accepted%' or r.status = 'approved' then 'approved'
         else 'submitted' end,
    r.transportation_type, r.expense_type, r.trip_start_date, r.trip_end_date,
    coalesce(r.to_label, r.to_city, r.to_area), r.distance_from_residence_km,
    r.fuel_amount, r.allowance_amount, r.go_ticket_amount, r.return_ticket_amount,
    r.meeting_amount, r.other_amount,
    case when r.claimed_total_amount > 0 then r.claimed_total_amount else r.expected_total_amount end,
    case when (r.status like 'accepted%' or r.status = 'approved') then coalesce(e.approved_amount, e.total) end,
    case when (r.status like 'accepted%' or r.status = 'approved') then e.approved_by end,
    case when (r.status like 'accepted%' or r.status = 'approved') then e.approved_at end,
    nullif(btrim(coalesce(r.approval_reason, '')), ''),
    extract(year from r.trip_start_date)::int, extract(month from r.trip_start_date)::int,
    case when (r.status like 'accepted%' or r.status = 'approved') then e.payout_year end,
    case when (r.status like 'accepted%' or r.status = 'approved') then e.payout_month end,
    r.evidence_gate_status, r.workload_gate_status, r.id, e.id, r.created_at
  from public.outstation_expense_requests r
  left join public.outstation_expenses e on e.trip_id = 'OUTSTATION-' || r.id
  left join (
    select distinct entity_id from public.audit_logs
    where entity_type = 'outstation_request' and summary ilike 'Admin created%'
  ) adm on adm.entity_id = r.id::text;

  insert into public.expense_claims (
    claim_ref, employee_hr_id, employee_name, source, import_id, status,
    transportation_type, expense_type, trip_start_date, trip_end_date, destination_label,
    distance_km, fuel_amount, allowance_amount, meeting_amount, other_amount,
    claimed_total, approved_total, decided_by_hr_id, decided_at, decision_reason,
    incurred_year, incurred_month, payout_year, payout_month, legacy_expense_id, created_at)
  select e.trip_id, e.hr_id, coalesce(nullif(btrim(e.specialist), ''), e.hr_id),
    case when e.source_file_name like '%.workflow' then 'admin_manual' else 'import' end,
    imp.id,
    case when e.hr_approved then 'approved'
         when coalesce(e.status, '') ilike '%reject%' then 'rejected'
         else 'submitted' end,
    e.transportation_type, e.trip_type, e.expense_date::timestamptz,
    coalesce(e.to_date, e.expense_date)::timestamptz,
    coalesce(nullif(btrim(coalesce(e.to_location, '')), ''), e.location), e.km,
    e.travel_cost, e.allowance, e.meeting_amount, e.other_amount, e.total,
    case when e.hr_approved then coalesce(e.approved_amount, e.total) end,
    case when e.hr_approved then e.approved_by end,
    case when e.hr_approved then e.approved_at end,
    nullif(btrim(coalesce(e.hr_comment, '')), ''),
    extract(year from e.expense_date)::int, extract(month from e.expense_date)::int,
    case when e.hr_approved then e.payout_year end,
    case when e.hr_approved then e.payout_month end,
    e.id, e.created_at
  from public.outstation_expenses e
  left join public.expense_imports imp
         on imp.file_name = e.source_file_name and e.source_file_name not like '%.workflow'
  where not exists (
    select 1 from public.outstation_expense_requests r where 'OUTSTATION-' || r.id = e.trip_id
  );

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

  insert into public.expense_claim_events (claim_id, actor_hr_id, event_type, message, metadata)
  select c.id, null, 'migrated',
    'Backfilled from ' || case
      when c.legacy_request_id is not null and c.legacy_expense_id is not null
        then 'outstation_expense_requests + outstation_expenses (merged)'
      when c.legacy_request_id is not null then 'outstation_expense_requests'
      else 'outstation_expenses' end,
    jsonb_strip_nulls(jsonb_build_object(
      'legacy_request_id', c.legacy_request_id, 'legacy_expense_id', c.legacy_expense_id,
      'source', c.source, 'status', c.status, 'claimed_total', c.claimed_total,
      'approved_total', c.approved_total,
      'component_sum', (c.fuel_amount + c.allowance_amount + c.ticket_go_amount
                        + c.ticket_return_amount + c.meeting_amount + c.other_amount),
      'data_quality_hold', case when c.data_quality_hold then true else null end,
      'data_quality_reason', c.data_quality_reason))
  from public.expense_claims c;

  select count(*) into v_claims  from public.expense_claims;
  select count(*) into v_imports from public.expense_imports;
  select count(*) into v_flagged from public.expense_claims where data_quality_hold;

  return jsonb_build_object(
    'claims', v_claims,
    'imports', v_imports,
    'flagged', v_flagged,
    'refreshed_at', now()
  );
end;
$function$;

-- `from public` is the load-bearing clause, not a formality: anon and authenticated inherit
-- EXECUTE through PUBLIC membership, so revoking only those two would be a no-op. Revoking PUBLIC
-- on a default ACL also strips service_role, hence the explicit re-grant below.
revoke execute on function public.phx_refresh_expense_claims() from public, anon, authenticated;
grant execute on function public.phx_refresh_expense_claims() to service_role;

comment on function public.phx_refresh_expense_claims() is
  'PHASE 2 ONLY. Rebuilds expense_claims from the legacy tables while they remain the source of '
  'truth. Refuses to run once any claim exists with no legacy link, because a full rebuild would '
  'destroy natively created claims.';

-- ── Parity: a live per-claim diff against the legacy rows ────────────────────────────────────
create or replace view public.v_expense_claims_parity as
with legacy as (
  -- the legacy view of every trip, using the SAME precedence the application uses:
  -- a request shadows its ledger row; the ledger row supplies the approved figure.
  select 'OUTSTATION-' || r.id as claim_ref,
         case when r.status like 'rejected%' then 'rejected'
              when r.status like 'accepted%' or r.status = 'approved' then 'approved'
              else 'submitted' end as status,
         (case when r.claimed_total_amount > 0 then r.claimed_total_amount
               else r.expected_total_amount end)::numeric(12,2) as claimed_total,
         (case when (r.status like 'accepted%' or r.status = 'approved')
               then coalesce(e.approved_amount, e.total) end)::numeric(12,2) as approved_total,
         lower(r.employee_hr_id) as employee_key
  from public.outstation_expense_requests r
  left join public.outstation_expenses e on e.trip_id = 'OUTSTATION-' || r.id
  union all
  select e.trip_id,
         case when e.hr_approved then 'approved'
              when coalesce(e.status, '') ilike '%reject%' then 'rejected'
              else 'submitted' end,
         e.total::numeric(12,2),
         (case when e.hr_approved then coalesce(e.approved_amount, e.total) end)::numeric(12,2),
         lower(e.hr_id)
  from public.outstation_expenses e
  where not exists (
    select 1 from public.outstation_expense_requests r where 'OUTSTATION-' || r.id = e.trip_id
  )
)
select
  coalesce(c.claim_ref, l.claim_ref)                                     as claim_ref,
  case
    when c.claim_ref is null then 'MISSING_IN_NEW'
    when l.claim_ref is null then 'MISSING_IN_LEGACY'
    when c.status is distinct from l.status then 'STATUS_DRIFT'
    when c.claimed_total is distinct from l.claimed_total then 'CLAIMED_DRIFT'
    when coalesce(c.approved_total, -1) is distinct from coalesce(l.approved_total, -1) then 'APPROVED_DRIFT'
    when c.employee_key is distinct from l.employee_key then 'EMPLOYEE_DRIFT'
    else 'OK'
  end                                                                    as verdict,
  c.status as new_status,          l.status as legacy_status,
  c.claimed_total as new_claimed,  l.claimed_total as legacy_claimed,
  c.approved_total as new_approved, l.approved_total as legacy_approved
from (
  select claim_ref, status, claimed_total, approved_total, lower(employee_hr_id) as employee_key
  from public.expense_claims
) c
full join legacy l on l.claim_ref = c.claim_ref;

comment on view public.v_expense_claims_parity is
  'PHASE 2 comparison harness. Every row where verdict <> ''OK'' is a real divergence between the '
  'new model and the legacy tables. Zero non-OK rows is the gate for phase 3.';

revoke all on public.v_expense_claims_parity from anon, authenticated;
grant select on public.v_expense_claims_parity to service_role;
