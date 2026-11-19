-- outstation_accept_claim_for_payroll_atomically
--
-- WHAT THIS CHANGES: one new function, phx_accept_outstation_claim_for_payroll. Approving an outstation expense
--   claim now does ALL of its database writes in ONE transaction:
--     1. the claim moves to accepted (status, calculation_status, the approval reason, updated_at) — only while it
--        still carries the updated_at the reviewer saw; otherwise it raises outstation_claim_changed before
--        anything is written (the 409 the screens already show);
--     2. when the claim is cleared for payroll: its payroll report row (updated, or inserted when it has none) and
--        its `outstation_expenses` row, upserted on trip_id, with exactly the figures the app worked out
--        (planPayrollExpenseSave in src/lib/outstation/expenses.ts — the same code the payroll save runs);
--     3. the approval's audit_logs rows ("expense pushed to payroll" and "accepted").
--   Either all of them land or none does. The app pushes the moved decision into any open payroll run after the
--   transaction commits (that follow-up never throws and has its own retry queue).
-- WHY: REC-038 close-out, 19 Nov 2026 (owner: "fix the outstation approval so it is one step"). The approval
--   made these as separate calls: if the payroll push failed, the claim still read accepted and an empty report
--   row was left behind; if a record failed, the money was queued while the approver was told the approval had
--   failed. Nothing about the money changes: the same rows are written with the same figures, only together.
-- ROLLBACK: drop function public.phx_accept_outstation_claim_for_payroll(bigint, timestamptz, text, text,
--   timestamptz, uuid, jsonb, jsonb, jsonb);  (and ship the matching code revert — approveOutstationRequestForPayroll
--   in src/lib/outstation/service.ts calls it).
--
-- Add-only: no table, column or row changes on apply, and the code live before this change does not call it. The
-- code that ships with it does: without the function, approving a claim refuses and changes nothing.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phx_accept_outstation_claim_for_payroll(
  p_request_id bigint,
  p_expected_updated_at timestamptz,
  p_status text,
  p_approval_reason text,
  p_updated_at timestamptz,
  p_report_id uuid,
  p_report jsonb,
  p_expense_rows jsonb,
  p_audits jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_request public.outstation_expense_requests%rowtype;
  v_report_id uuid := p_report_id;
  v_expenses jsonb := '[]'::jsonb;
begin
  -- The claim first, pinned to the version the reviewer approved: a claim that moved refuses before anything else.
  update public.outstation_expense_requests
     set approval_reason = coalesce(p_approval_reason, ''),
         calculation_status = p_status,
         status = p_status,
         updated_at = p_updated_at
   where id = p_request_id
     and updated_at = p_expected_updated_at
  returning * into v_request;

  if not found then
    raise exception 'outstation_claim_changed: the claim changed after it was read, so it was not approved'
      using errcode = 'P0001';
  end if;

  if p_expense_rows is not null and jsonb_array_length(p_expense_rows) > 0 then
    if v_report_id is not null then
      update public.outstation_expense_reports
         set approved_rows = (p_report ->> 'approved_rows')::integer,
             file_name = p_report ->> 'file_name',
             row_count = (p_report ->> 'row_count')::integer,
             total_expenses = (p_report ->> 'total_expenses')::numeric,
             trip_date_from = (p_report ->> 'trip_date_from')::date,
             trip_date_to = (p_report ->> 'trip_date_to')::date,
             updated_at = (p_report ->> 'updated_at')::timestamptz
       where id = v_report_id;
    else
      insert into public.outstation_expense_reports
        (approved_rows, file_name, row_count, total_expenses, trip_date_from, trip_date_to, updated_at)
      values (
        (p_report ->> 'approved_rows')::integer,
        p_report ->> 'file_name',
        (p_report ->> 'row_count')::integer,
        (p_report ->> 'total_expenses')::numeric,
        (p_report ->> 'trip_date_from')::date,
        (p_report ->> 'trip_date_to')::date,
        (p_report ->> 'updated_at')::timestamptz
      )
      returning id into v_report_id;
    end if;

    -- The rows exactly as the app planned them; the report id is the one above. Upserted on trip_id, as the
    -- payroll save upserts them, so a second push of the same trip can never become a second row (REC-035).
    with incoming as (
      select * from jsonb_populate_recordset(null::public.outstation_expenses, p_expense_rows)
    ),
    written as (
      insert into public.outstation_expenses (
        allowance, am_workload, approved_amount, approved_at, approved_by, description, hr_id, expense_date,
        from_location, hr_approved, hr_comment, hr_notes, hr_status, km, location, meeting_amount, other_amount,
        payout_month, payout_year, pharmacy_workload, pm_workload, request_type, report_id, source_file_name,
        source_row, specialist, status, to_date, to_location, total, transportation_type, travel_cost, trip_id,
        trip_type, updated_at
      )
      select
        allowance, am_workload, approved_amount, approved_at, approved_by, description, hr_id, expense_date,
        from_location, hr_approved, hr_comment, hr_notes, hr_status, km, location, meeting_amount, other_amount,
        payout_month, payout_year, pharmacy_workload, pm_workload, request_type, v_report_id, source_file_name,
        source_row, specialist, status, to_date, to_location, total, transportation_type, travel_cost, trip_id,
        trip_type, updated_at
      from incoming
      on conflict (trip_id) do update set
        allowance = excluded.allowance,
        am_workload = excluded.am_workload,
        approved_amount = excluded.approved_amount,
        approved_at = excluded.approved_at,
        approved_by = excluded.approved_by,
        description = excluded.description,
        hr_id = excluded.hr_id,
        expense_date = excluded.expense_date,
        from_location = excluded.from_location,
        hr_approved = excluded.hr_approved,
        hr_comment = excluded.hr_comment,
        hr_notes = excluded.hr_notes,
        hr_status = excluded.hr_status,
        km = excluded.km,
        location = excluded.location,
        meeting_amount = excluded.meeting_amount,
        other_amount = excluded.other_amount,
        payout_month = excluded.payout_month,
        payout_year = excluded.payout_year,
        pharmacy_workload = excluded.pharmacy_workload,
        pm_workload = excluded.pm_workload,
        request_type = excluded.request_type,
        report_id = excluded.report_id,
        source_file_name = excluded.source_file_name,
        source_row = excluded.source_row,
        specialist = excluded.specialist,
        status = excluded.status,
        to_date = excluded.to_date,
        to_location = excluded.to_location,
        total = excluded.total,
        transportation_type = excluded.transportation_type,
        travel_cost = excluded.travel_cost,
        trip_type = excluded.trip_type,
        updated_at = excluded.updated_at
      returning *
    )
    select coalesce(jsonb_agg(to_jsonb(written)), '[]'::jsonb) into v_expenses from written;
  end if;

  insert into public.audit_logs (actor_login_id, entity_id, entity_type, new_values, old_values, summary)
  select
    coalesce(audit ->> 'actor_login_id', 'system'),
    audit ->> 'entity_id',
    audit ->> 'entity_type',
    nullif(audit -> 'new_values', 'null'::jsonb),
    nullif(audit -> 'old_values', 'null'::jsonb),
    audit ->> 'summary'
  from jsonb_array_elements(coalesce(p_audits, '[]'::jsonb)) as audit;

  return jsonb_build_object('request', to_jsonb(v_request), 'report_id', v_report_id, 'expenses', v_expenses);
end;
$$;

comment on function public.phx_accept_outstation_claim_for_payroll(bigint, timestamptz, text, text, timestamptz, uuid, jsonb, jsonb, jsonb) is
  'Approves an outstation expense claim in one transaction: the claim (pinned to the version the reviewer saw), its '
  'payroll report and outstation_expenses row as the app planned them, and the approval''s audit rows '
  '(REC-038, 19 Nov 2026).';

revoke execute on function public.phx_accept_outstation_claim_for_payroll(bigint, timestamptz, text, text, timestamptz, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.phx_accept_outstation_claim_for_payroll(bigint, timestamptz, text, text, timestamptz, uuid, jsonb, jsonb, jsonb) to service_role;

commit;
