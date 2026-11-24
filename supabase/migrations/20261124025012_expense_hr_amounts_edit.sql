-- expense_hr_amounts_edit
--
-- WHAT THIS CHANGES:
--   1. outstation_expense_requests.hr_amounts jsonb, nullable: the Super Admin's own figures for a
--      trip, part by part (travel, allowance, meeting, other) with the reason, who and when
--      (src/lib/outstation/hr-amounts.ts). NULL = never edited, which is every row today.
--   2. expense_claims.approved_above_claim boolean not null default false, and the range check
--      expense_claims_approved_total_range relaxed to accept an approved total above the claim ONLY
--      on a row that carries that flag.
--   3. phx_refresh_expense_claims() and v_expense_claims_parity: the over-claim guard lets an edited
--      trip's figure through (and sets the flag) instead of mirroring it as NULL. Every other line is
--      the live definition unchanged (20260925063124 for the function, 20260903160000 for the view).
-- WHY: owner, 24 Nov 2026: "i want to be able to edit in expense value" — each part, on waiting and
--      decided claims, any figure including above the claim, until a payroll takes the trip. Without
--      2 and 3 an above-claim edit would mirror as "not representable" with a misleading hold reason.
-- DATA: no row is written. Every request has hr_amounts NULL, so the guard behaves exactly as before
--      until a figure is edited, and the flag starts false on every claim.
-- ROLLBACK: re-run 20260925063124 and the view from 20260903160000; then
--      alter table public.expense_claims drop constraint expense_claims_approved_total_range,
--        add constraint expense_claims_approved_total_range check (approved_total is null or
--        (approved_total >= 0 and approved_total <= claimed_total));
--      alter table public.expense_claims drop column approved_above_claim;
--      alter table public.outstation_expense_requests drop column hr_amounts;
--      (drop hr_amounts only after no trip carries an edit you want to keep).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

begin;

alter table public.outstation_expense_requests
  add column if not exists hr_amounts jsonb;

comment on column public.outstation_expense_requests.hr_amounts is
  'The Super Admin''s own figures for this trip: {travel, allowance, meeting, other, reason, by, setAt, before}. NULL = never edited. When present, payroll pays these parts (src/lib/outstation/hr-amounts.ts); the claimed columns keep what the employee sent.';

alter table public.expense_claims
  add column if not exists approved_above_claim boolean not null default false;

comment on column public.expense_claims.approved_above_claim is
  'True when the Super Admin set this trip''s figures and they pay more than the claim. Only then may approved_total exceed claimed_total.';

alter table public.expense_claims
  drop constraint if exists expense_claims_approved_total_range;
alter table public.expense_claims
  add constraint expense_claims_approved_total_range check (
    approved_total is null
    or (approved_total >= 0 and (approved_total <= claimed_total or approved_above_claim))
  );

-- The function and the view below are the live definitions with only the over-claim guard changed;
-- the inline commentary of each lives in 20260925063124 and 20260903160000, where it was written.
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
    approved_above_claim,
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
    case when (r.status like 'accepted%' or r.status = 'approved')
          and (r.hr_amounts is not null
               or coalesce(e.approved_amount, e.total)::numeric(12,2)
                  <= (case when r.claimed_total_amount > 0 then r.claimed_total_amount
                           else r.expected_total_amount end)::numeric(12,2))
         then coalesce(e.approved_amount, e.total) end,
    coalesce(r.hr_amounts is not null
             and (r.status like 'accepted%' or r.status = 'approved')
             and coalesce(e.approved_amount, e.total)::numeric(12,2)
                 > (case when r.claimed_total_amount > 0 then r.claimed_total_amount
                         else r.expected_total_amount end)::numeric(12,2), false),
    case when (r.status like 'accepted%' or r.status = 'approved') then e.approved_by end,
    case when (r.status like 'accepted%' or r.status = 'approved')
         then coalesce(e.approved_at, r.updated_at) end,
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
    case when e.hr_approved
          and coalesce(e.approved_amount, e.total)::numeric(12,2) <= e.total::numeric(12,2)
         then coalesce(e.approved_amount, e.total) end,
    case when e.hr_approved then e.approved_by end,
    case when e.hr_approved then coalesce(e.approved_at, e.created_at) end,
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

  update public.expense_claims c
  set data_quality_hold = true,
      data_quality_reason = coalesce(c.data_quality_reason || ' | ', '')
        || 'Legacy approved amount '
        || to_char(coalesce(e.approved_amount, e.total)::numeric(12,2), 'FM999999990.00')
        || ' is above the recorded claim total '
        || to_char(c.claimed_total, 'FM999999990.00')
        || ', so no approved amount was mirrored. Those two figures come from different tables - '
        || 'the claim total from outstation_expense_requests, the approved amount from '
        || 'outstation_expenses - so check whether the expense components still sum to the '
        || 'recorded claim before treating this as an over-approval. Payroll reads the legacy row '
        || 'and is unaffected.'
  from public.outstation_expenses e
  where e.id = c.legacy_expense_id
    and c.status = 'approved'
    and c.approved_total is null
    and coalesce(e.approved_amount, e.total)::numeric(12,2) > c.claimed_total;

  update public.expense_claims c
  set data_quality_hold = true,
      data_quality_reason = coalesce(c.data_quality_reason || ' | ', '')
        || case
             when coalesce(c.evidence_gate_status, '') like 'pending%'
               or coalesce(c.workload_gate_status, '') like 'pending%'
             then 'Accepted and HELD OUT OF PAYROLL in the same action: this trip''s evidence or '
               || 'workload gate has not landed yet, so no outstation_expenses row exists for it - '
               || 'that is the designed state of a held acceptance, not a missing row. The date '
               || 'shown is the request''s last save in outstation_expense_requests, NOT an '
               || 'approval time: the status comes from the request and the timestamp normally '
               || 'comes from the expense row, which is written when the gates clear. Do NOT create '
               || 'that row by hand - it is what payroll pays from, and the gate is holding this '
               || 'trip out on purpose. No approved amount was mirrored, and payroll reads the '
               || 'legacy rows, so pay is unaffected.'
             else 'Accepted with no recorded approval timestamp: the gates are clear, yet no '
               || 'outstation_expenses row exists for this request, so the decision date shown is '
               || 'the request''s last save in outstation_expense_requests, NOT an approval. The '
               || 'status comes from the request and the timestamp normally comes from the expense '
               || 'row. Repair the missing expense row rather than reading this date as a '
               || 'decision. No approved amount was mirrored, and payroll reads the legacy rows, '
               || 'so pay is unaffected.'
           end
  where c.status = 'approved'
    and c.legacy_request_id is not null
    and c.legacy_expense_id is null;

  update public.expense_claims c
  set data_quality_hold = true,
      data_quality_reason = coalesce(c.data_quality_reason || ' | ', '')
        || 'Legacy expense row is marked approved but carries no approval timestamp, so the date '
        || 'shown is when the row was created, not when it was approved.'
  from public.outstation_expenses e
  where e.id = c.legacy_expense_id
    and c.status = 'approved'
    and e.approved_at is null;

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

revoke execute on function public.phx_refresh_expense_claims() from public, anon, authenticated;
grant execute on function public.phx_refresh_expense_claims() to service_role;

create or replace view public.v_expense_claims_parity as
with legacy as (
  select 'OUTSTATION-' || r.id as claim_ref,
    case when r.status like 'rejected%' then 'rejected'
         when r.status like 'accepted%' or r.status = 'approved' then 'approved'
         else 'submitted' end as status,
    (case when r.claimed_total_amount > 0 then r.claimed_total_amount
          else r.expected_total_amount end)::numeric(12,2) as claimed_total,
    (case when (r.status like 'accepted%' or r.status = 'approved')
           and (r.hr_amounts is not null
                or coalesce(e.approved_amount, e.total)::numeric(12,2)
                   <= (case when r.claimed_total_amount > 0 then r.claimed_total_amount
                            else r.expected_total_amount end)::numeric(12,2))
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

-- The ledger row. Both Supabase tools decline this file (the function body contains `delete`), so it
-- is applied through `scripts/apply-sql-file.mjs`, which writes no ledger row — so it is written here,
-- with the FILE's own version, guarded on the new column being live and on the row not existing.
insert into supabase_migrations.schema_migrations (version, name)
select '20261124025012', 'expense_hr_amounts_edit'
where exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'outstation_expense_requests' and column_name = 'hr_amounts'
      )
  and not exists (
        select 1 from supabase_migrations.schema_migrations where version = '20261124025012'
      );

commit;
