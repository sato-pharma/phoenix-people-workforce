-- The hourly expense_claims rebuild must FLAG an over-claim, not die on it.
--
-- WHAT BROKE. `expense_claims_approved_total_range` forbids `approved_total > claimed_total` --
-- outstation approval exists to REDUCE a claim and never pays more than was asked for. Two legacy
-- rows violate that rule: OUTSTATION-52 carries 800.00 approved against 364.00 claimed, and
-- OUTSTATION-99 carries 541.90 against 341.90. They were written through `normalizeApprovedAmount`
-- (src/lib/outstation/payable.ts), the one of that module's three amount helpers that omitted the
-- cap its two siblings apply; that omission is fixed in the same change as this migration, so no
-- NEW row can land above its claim.
--
-- The rebuild deletes and re-inserts all four mirror tables inside ONE transaction, so those two
-- rows rolled the whole statement back: from 2026-09-03 the job failed every hour and all 416
-- claims stopped refreshing because of 2. Reads are live on this mirror in production
-- (PHOENIX_EXPENSE_CLAIMS_READ=true), and a stale mirror is invisible from the product -- the rows
-- are simply not there, which is exactly how 31 approved claims worth EGP 15,294.74 hid from the
-- approvals queue for ten days in August.
--
-- WHAT THIS CHANGES. An approved amount above the claim is no longer mirrored: `approved_total`
-- stays NULL and the row is marked `data_quality_hold` with a reason naming BOTH amounts. That
-- follows the precedent already in this function for the other legacy inconsistency it cannot
-- represent ("Components do not sum to the claimed total (legacy). Owner deferred 2026-08-12.").
-- The count comes back in the response body as `flagged`, so the two rows stay visible and
-- countable instead of being silently clamped down to the claim.
--
-- IT DELIBERATELY DECIDES NOTHING ABOUT THE MONEY. Payroll reads the LEGACY row through
-- `payableExpenseAmount`, which returns the approved figure verbatim -- so those two trips are
-- still priced at 800.00 and 541.90 today. Whether that is right is the owner's call, not this
-- migration's; nothing here rewrites a legacy amount. This only stops one bad row freezing the
-- other 414.
--
-- THE VIEW MOVES WITH THE FUNCTION, AND MUST KEEP MOVING WITH IT. `v_expense_claims_parity`
-- compares the mirror against the legacy tables, and the route returns HTTP 500 and pings the
-- dead-man's switch /fail when any row is not OK. If only the function nulled the over-claim
-- amount, `coalesce(c.approved_total, -1) is distinct from coalesce(l.approved_total, -1)` would be
-- true for those two rows on every run, turning an hourly failure into a permanent one. So the
-- view's legacy CTE applies the SAME clamp, in the same numeric(12,2) the CHECK constraint sees.
-- Parity answers "did the rebuild reproduce legacy"; `flagged` answers "does legacy hold something
-- the mirror cannot represent". Change one clamp and you must change the other.

create or replace function public.phx_refresh_expense_claims()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $function$
declare
  v_native_claims integer;
  v_payroll_links integer;
  v_claims        integer;
  v_imports       integer;
  v_flagged       integer;
begin
  select count(*) into v_native_claims
  from public.expense_claims
  where legacy_request_id is null and legacy_expense_id is null;

  if v_native_claims > 0 then
    raise exception
      'Refusing to rebuild: % claim(s) have no legacy link, so they were created natively. phx_refresh_expense_claims is a PHASE 2 tool and is unsafe once writes have cut over.',
      v_native_claims
      using errcode = 'P0001';
  end if;

  select count(*) into v_payroll_links from public.expense_payroll_links;

  if v_payroll_links > 0 then
    raise exception
      'Refusing to rebuild: % expense_payroll_links row(s) exist. This function DELETES that table and never rebuilds it, so rebuilding now would destroy payroll linkage that nothing can recover. Phase 4 has armed - retire this phase-2 refresh, or clear and re-link deliberately.',
      v_payroll_links
      using errcode = 'P0001';
  end if;

  -- `where true` is load-bearing: PostgREST's `authenticator` role preloads `safeupdate`, which
  -- refuses an unqualified DELETE. Removing it makes this function work by hand and fail hourly.
  delete from public.expense_claim_events where true;
  delete from public.expense_payroll_links where true;
  delete from public.expense_claims where true;
  delete from public.expense_imports where true;

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
    -- Over-claim guard. Cast to the mirror's column type so this predicate sees exactly what
    -- `expense_claims_approved_total_range` will see. NULL here means "not representable", and the
    -- hold update further down records why.
    case when (r.status like 'accepted%' or r.status = 'approved')
          and coalesce(e.approved_amount, e.total)::numeric(12,2)
              <= (case when r.claimed_total_amount > 0 then r.claimed_total_amount
                       else r.expected_total_amount end)::numeric(12,2)
         then coalesce(e.approved_amount, e.total) end,
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
    -- The same over-claim guard as the request-derived insert above.
    case when e.hr_approved
          and coalesce(e.approved_amount, e.total)::numeric(12,2) <= e.total::numeric(12,2)
         then coalesce(e.approved_amount, e.total) end,
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

  -- The over-claim hold. Records what the mirror refused to carry, naming both amounts, so the row
  -- is countable in `flagged` and readable on the claim instead of vanishing.
  update public.expense_claims c
  set data_quality_hold = true,
      data_quality_reason = coalesce(c.data_quality_reason || ' | ', '')
        || 'Legacy approved amount '
        || to_char(coalesce(e.approved_amount, e.total)::numeric(12,2), 'FM999999990.00')
        || ' exceeds the claimed total '
        || to_char(c.claimed_total, 'FM999999990.00')
        || '. Outstation approval never pays more than was claimed, so no approved amount was '
        || 'mirrored. Payroll still reads the legacy figure: this needs an owner decision.'
  from public.outstation_expenses e
  where e.id = c.legacy_expense_id
    and c.status = 'approved'
    and c.approved_total is null
    and coalesce(e.approved_amount, e.total)::numeric(12,2) > c.claimed_total;

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

  return jsonb_build_object('claims', v_claims, 'imports', v_imports,
                            'flagged', v_flagged, 'refreshed_at', now());
end;
$function$;

-- The parity view's legacy side carries the IDENTICAL clamp, so a held over-claim reads as OK
-- rather than as permanent APPROVED_DRIFT. Without this the route would return 500 on every run.
create or replace view public.v_expense_claims_parity as
with legacy as (
  select 'OUTSTATION-' || r.id as claim_ref,
    case when r.status like 'rejected%' then 'rejected'
         when r.status like 'accepted%' or r.status = 'approved' then 'approved'
         else 'submitted' end as status,
    (case when r.claimed_total_amount > 0 then r.claimed_total_amount
          else r.expected_total_amount end)::numeric(12,2) as claimed_total,
    (case when (r.status like 'accepted%' or r.status = 'approved')
           and coalesce(e.approved_amount, e.total)::numeric(12,2)
               <= (case when r.claimed_total_amount > 0 then r.claimed_total_amount
                        else r.expected_total_amount end)::numeric(12,2)
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
    (case when e.hr_approved
           and coalesce(e.approved_amount, e.total)::numeric(12,2) <= e.total::numeric(12,2)
          then coalesce(e.approved_amount, e.total) end)::numeric(12,2),
    lower(e.hr_id)
  from public.outstation_expenses e
  where not exists (
    select 1 from public.outstation_expense_requests r where 'OUTSTATION-' || r.id = e.trip_id
  )
)
select coalesce(c.claim_ref, l.claim_ref) as claim_ref,
  case
    when c.claim_ref is null then 'MISSING_IN_NEW'
    when l.claim_ref is null then 'MISSING_IN_LEGACY'
    when c.status is distinct from l.status then 'STATUS_DRIFT'
    when c.claimed_total is distinct from l.claimed_total then 'CLAIMED_DRIFT'
    when coalesce(c.approved_total, -1) is distinct from coalesce(l.approved_total, -1) then 'APPROVED_DRIFT'
    when c.employee_key is distinct from l.employee_key then 'EMPLOYEE_DRIFT'
    else 'OK'
  end as verdict,
  c.status as new_status,
  l.status as legacy_status,
  c.claimed_total as new_claimed,
  l.claimed_total as legacy_claimed,
  c.approved_total as new_approved,
  l.approved_total as legacy_approved
from (
  select expense_claims.claim_ref, expense_claims.status, expense_claims.claimed_total,
    expense_claims.approved_total, lower(expense_claims.employee_hr_id) as employee_key
  from public.expense_claims
) c
full join legacy l on l.claim_ref = c.claim_ref;
