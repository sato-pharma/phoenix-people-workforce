-- Make phx_refresh_expense_claims() runnable over HTTP. It never was.
--
-- The function has been correct and hand-runnable since it was written, and every invocation until
-- now went through a direct SQL session (psql / the Supabase SQL editor / MCP), where it works.
-- The scheduled caller added in #2677 is the first thing ever to call it through PostgREST, and it
-- failed on the very first request with an opaque 400.
--
-- THE CAUSE. PostgREST connects as `authenticator`, and on this project that role carries:
--
--   session_preload_libraries = supautils, safeupdate
--   statement_timeout = 8s, lock_timeout = 8s, idle_in_transaction_session_timeout = 15s
--
-- `safeupdate` rejects any DELETE or UPDATE with no WHERE clause. This function opens with four
-- unqualified deletes, so through PostgREST it dies immediately on the first one:
--
--   ERROR: DELETE requires a WHERE clause          (production log, 2026-08-29 18:25:35.711 UTC,
--                                                   the exact millisecond of the failed RPC)
--
-- A direct SQL session does not preload `safeupdate` (measured: session_preload_libraries reads
-- `supautils` alone), which is exactly why every hand-run succeeded and hid this. SECURITY DEFINER
-- does not help — the library is preloaded per SESSION, not per function owner, so the definer's
-- privileges are irrelevant to it.
--
-- THE FIX, in two parts:
--
--  1. `where true` on all four deletes. Semantically identical — `safeupdate` objects to the absent
--     clause, not to the row count — and it keeps the FK-ordered delete sequence exactly as it was.
--     TRUNCATE was rejected as the alternative: it would need CASCADE or a matching order anyway,
--     it takes ACCESS EXCLUSIVE locks against a `lock_timeout` of 8s, and it fires no row triggers.
--
--  2. `set statement_timeout to '60s'` on the function. `authenticator` caps statements at 8s, and
--     that cap applies on the HTTP path ONLY — so the rebuild would keep working by hand while
--     failing hourly in production the moment it outgrew 8 seconds, which is the same class of
--     invisible divergence this migration exists to close. 60s sits under the route's
--     maxDuration of 120s, so the caller still bounds the request.
--
-- Everything else is byte-for-byte the function as it stood after
-- 20260829181500_expense_claims_refresh_payroll_links_interlock.sql. Both interlocks are unchanged
-- and both still run BEFORE any delete.

create or replace function public.phx_refresh_expense_claims()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $$
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

  return jsonb_build_object('claims', v_claims, 'imports', v_imports,
                            'flagged', v_flagged, 'refreshed_at', now());
end;
$$;

revoke execute on function public.phx_refresh_expense_claims() from public, anon, authenticated;
grant execute on function public.phx_refresh_expense_claims() to service_role;

comment on function public.phx_refresh_expense_claims() is
  'PHASE 2 tool: rebuilds expense_claims/expense_imports/expense_claim_events from the legacy outstation tables. Idempotent. Refuses to run when any claim has no legacy link (writes have cut over) or when expense_payroll_links is non-empty (it deletes that table and cannot rebuild it). Deletes are WHERE-qualified because PostgREST''s authenticator role preloads safeupdate; statement_timeout is raised because that role caps statements at 8s.';
