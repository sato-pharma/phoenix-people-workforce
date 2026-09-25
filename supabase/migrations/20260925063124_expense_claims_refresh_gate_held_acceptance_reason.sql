-- expense_claims_refresh_gate_held_acceptance_reason
--
-- WHAT THIS CHANGES: redefines public.phx_refresh_expense_claims() (same signature, same
-- SECURITY DEFINER, same search_path and statement_timeout). ONE edit: the substituted-decision
-- hold on the request side now says WHY the expense row is absent, splitting the two cases that
-- reach it — gates still pending (by design) and gates clear (a real gap) — and it no longer tells
-- the reader to create the missing row in the by-design case. Nothing else moves: no predicate, no
-- amount, no timestamp, no status.
--
-- WHY: the reason text shipped on 2026-09-21 named the missing outstation_expenses row as the
-- defect and said "Repair the missing expense row rather than reading this date as a decision".
-- For the row that produced it, that advice is backwards. Request 111 (OUTSTATION-111, B-118 Amgad
-- Ibrahim, CNS / Upper Egypt, trip 2026-08-31) was accepted by B-10 on 2026-09-18 23:31 Cairo and
-- HELD OUT OF PAYROLL in the same action — the audit row reads "accepted (accepted_by_admin) but
-- HELD out of payroll: Waiting for the departure photo", and both gates still read
-- pending_departure_photo / pending_workload. `service.ts` is explicit that this state carries no
-- payroll row at all ("the evidence gate is holding the trip out of payroll, so there is no row to
-- carry either"), so the absent outstation_expenses row is the DESIGNED state of a held
-- acceptance, not damage to repair. outstation_expenses is the row payroll pays from, so a reader
-- who follows the old wording and creates one by hand moves a deliberately held trip toward
-- payment — the one outcome the gate exists to prevent. 12 more requests sit in the same
-- pending_departure_photo + pending_workload state on production today and will each land in this
-- hold as they are accepted, so the wording is not a one-row cosmetic.
--
-- The gates-clear case keeps the old wording, because there the missing row IS a gap: that is the
-- 2026-09-07 shape (requests 38, 39, 41, 55), already closed at source.
--
-- This changes NO money and no status. The hold flag, decided_at, approved_total and every
-- predicate are exactly as they were; only the sentence a reader sees changes. Payroll reads the
-- legacy rows, not this mirror.
--
-- ROLLBACK: re-create the function with the single `case when ... like 'pending%' ... end`
-- expression in the request-side hold replaced by the literal text from
-- 20260921002122_expense_claims_refresh_requires_decided_at.sql. Nothing else needs undoing — the
-- function rebuilds the mirror from source on every run, so the next run erases whatever this one
-- wrote.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: it replaces one function, creates and drops nothing, and touches no row outside
-- the mirror the function itself rebuilds hourly. The mirror's pre-image was nevertheless taken
-- into expenses_backup_20260925 before the first rebuild after this migration, because that
-- rebuild was the first since 2026-09-20 00:51 Cairo.

begin;

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
    -- DECIDED-AT FALLBACK. `status` one line up is read from the REQUEST; this timestamp is read
    -- from the EXPENSE row, and the join to it below is a LEFT JOIN. An accepted request that never
    -- got an outstation_expenses row therefore produced status 'approved' with decided_at NULL,
    -- which `expense_claims_approved_needs_decision` rejects -- aborting the ENTIRE rebuild over one
    -- row, so the mirror went stale for everybody. Fall back to the request's own last-save time:
    -- the acceptance is real and must keep its status, but r.updated_at is when the request row was
    -- last written and is NOT a recorded decision. The hold block further down says so in words.
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
    -- The same over-claim guard as the request-derived insert above.
    case when e.hr_approved
          and coalesce(e.approved_amount, e.total)::numeric(12,2) <= e.total::numeric(12,2)
         then coalesce(e.approved_amount, e.total) end,
    case when e.hr_approved then e.approved_by end,
    -- The same decided-at fallback as the insert above, for the same constraint. No legacy row is
    -- in this state on production today (measured 2026-09-21: zero); this closes the hole before
    -- one is, rather than after a night of the mirror being down.
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

  -- The over-claim hold. Names both amounts AND where each came from, because they live in
  -- different tables and a stale request header -- not an over-approval -- is what produced both
  -- known cases. A reason that misnames the cause sends the next reader after the wrong row.
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

  -- The substituted-decision hold, request side. Same shape as the over-claim hold above and for
  -- the same reason: the status came from one table and the timestamp from another, and when the
  -- second had nothing to give we substituted rather than failing the whole rebuild. Say plainly
  -- which date is on the row, so nobody reads it as an approval time or as evidence of a decision.
  --
  -- WHICH CASE IT IS decides what the reader should DO, so the two are not worded alike. A trip
  -- whose evidence or workload gate is still pending has no outstation_expenses row BY DESIGN --
  -- the acceptance and the payroll hold are one action (`service.ts`: "the evidence gate is holding
  -- the trip out of payroll, so there is no row to carry either"), and outstation_expenses is what
  -- payroll pays from, so creating one by hand pays a trip the gate is deliberately holding. Only
  -- when the gates are CLEAR is a missing row a gap worth repairing; that is the 2026-09-07 shape.
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

  -- The substituted-decision hold, legacy-expense side.
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

-- A public SECURITY DEFINER function is callable through PUBLIC membership unless PUBLIC itself is
-- revoked; anon and authenticated inherit EXECUTE that way, and the anon key ships in the browser
-- bundle. Re-assert the grant this function already carries on production (service_role only).
revoke execute on function public.phx_refresh_expense_claims() from public, anon, authenticated;
grant execute on function public.phx_refresh_expense_claims() to service_role;

commit;
