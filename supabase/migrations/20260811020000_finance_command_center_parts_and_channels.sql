-- Finance Command Center, v3 — no deductions on the page, and the payout split he actually runs.
--
-- Owner instruction (2026-08-10): "i do not want to see the word deduction in his overview. show
-- headcount, direct orders, payroll first vs second, FAB vs CIB vs Treasury, headcount."
--
-- WHAT CHANGED
--   * Every deduction figure is GONE from the payload — the committed-month rows keep net/gross
--     and drop total_deductions and the per-category columns, and the run rows drop the decided
--     total. Nothing on his overview computes or names a deduction any more.
--   * `payroll.parts` — first payment vs second. `payment_mode` is the field that decides it:
--     `one_part` is settled entirely in Part 1 (recommend.ts:1429), `two_parts` is not settled in
--     Part 1 and is handled in Part 2 (:1434). A NULL is not a third case — normalizePayrollPaymentMode
--     defaults it to `two_parts` (data-quality.ts:117), so it is folded in here rather than
--     reported as an "unset" bucket that would not match what the run does.
--   * `payroll.channels` — FAB vs CIB vs Treasury, mirroring how the bank files are actually built:
--       FAB      -> bank_name = 'FAB'   (exports/fab-sheet.ts)
--       CIB      -> bank_name = 'CIB'   (exports/cib-sheet.ts, which also requires a real account
--                                        number, so a CIB employee with no account is NOT in the file)
--       Treasury -> everyone else: no usable bank, so they are paid in cash and appear in neither
--                   bank file. This is the bucket that has no export of its own, which is exactly
--                   why it belongs on the dashboard.
--     Verified against production 2026-08-10: FAB 74 / CIB 11 / Treasury 40 = 125 payroll-eligible,
--     and 1,533,000 + 366,000 + 722,000 = 2,621,000 = the standing net. The three buckets are
--     exhaustive and non-overlapping by construction, so the page can never show a split that does
--     not add up to the payroll it sits next to.
--
-- Unchanged: one round trip, statement_timeout in the CREATE header, EXECUTE revoked from PUBLIC
-- and re-granted to service_role only.

create or replace function public.phx_finance_command_center(
  p_actor_hr_id text default null,
  p_trend_months int default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '20s'
as $$
declare
  v_actor      text := nullif(btrim(coalesce(p_actor_hr_id, '')), '');
  v_months     int  := greatest(1, least(24, coalesce(p_trend_months, 6)));
  v_headcount  jsonb;
  v_parts      jsonb;
  v_channels   jsonb;
  v_committed  jsonb;
  v_runs       jsonb;
  v_direct     jsonb;
  v_marketing  jsonb;
  v_leave      jsonb;
begin
  -- Headcount, plus the two leaver figures finance needs before it can close a month: who resigned
  -- inside the current Cairo month, and whose last working day falls in it. The month boundary is
  -- taken in Africa/Cairo, never UTC — a resignation logged late on the 31st is this month's, and
  -- at UTC it would land in the next one.
  select jsonb_build_object(
           'activeEmployees',    count(*) filter (where lower(coalesce(employment_status, '')) in ('active', 'on_leave')),
           'payrollEligible',    count(*) filter (where payroll_eligible),
           'standingNet',        round(coalesce(sum(net_salary)   filter (where payroll_eligible), 0)::numeric, 2),
           'standingGross',      round(coalesce(sum(gross_salary) filter (where payroll_eligible), 0)::numeric, 2),
           'resignedThisMonth',  count(*) filter (where resignation_date >= date_trunc('month', (now() at time zone 'Africa/Cairo'))::date),
           'leavingThisMonth',   count(*) filter (where last_working_date >= date_trunc('month', (now() at time zone 'Africa/Cairo'))::date),
           'leaversTotal',       count(*) filter (where lower(coalesce(employment_status, '')) in ('resigned', 'terminated'))
         )
    into v_headcount
    from public.employees;

  -- First payment vs second. NULL folds into two_parts to match normalizePayrollPaymentMode.
  select jsonb_build_object(
           'firstOnlyCount', count(*) filter (where lower(coalesce(payment_mode, '')) = 'one_part'),
           'firstOnlyNet',   round(coalesce(sum(net_salary) filter (where lower(coalesce(payment_mode, '')) = 'one_part'), 0)::numeric, 2),
           'bothPartsCount', count(*) filter (where lower(coalesce(payment_mode, '')) <> 'one_part'),
           'bothPartsNet',   round(coalesce(sum(net_salary) filter (where lower(coalesce(payment_mode, '')) <> 'one_part'), 0)::numeric, 2)
         )
    into v_parts
    from public.employees
    where payroll_eligible;

  -- FAB / CIB / Treasury. Exhaustive and non-overlapping: anyone not on a named bank is Treasury.
  select jsonb_build_object(
           'fabCount',      count(*) filter (where upper(coalesce(bank_name, '')) = 'FAB'),
           'fabNet',        round(coalesce(sum(net_salary) filter (where upper(coalesce(bank_name, '')) = 'FAB'), 0)::numeric, 2),
           'cibCount',      count(*) filter (where upper(coalesce(bank_name, '')) = 'CIB'),
           'cibNet',        round(coalesce(sum(net_salary) filter (where upper(coalesce(bank_name, '')) = 'CIB'), 0)::numeric, 2),
           'treasuryCount', count(*) filter (where upper(coalesce(bank_name, '')) not in ('FAB', 'CIB')),
           'treasuryNet',   round(coalesce(sum(net_salary) filter (where upper(coalesce(bank_name, '')) not in ('FAB', 'CIB')), 0)::numeric, 2)
         )
    into v_channels
    from public.employees
    where payroll_eligible;

  -- Net and gross only. No deduction columns are selected at all.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.period), '[]'::jsonb)
    into v_committed
    from (
      select
        to_char(make_date(b.year, b.month, 1), 'YYYY-MM')            as period,
        b.status                                                     as status,
        count(r.*)                                                   as employees,
        round(coalesce(sum(r.net_salary), 0)::numeric, 2)            as net,
        round(coalesce(sum(r.gross_salary), 0)::numeric, 2)          as gross
      from public.salary_batches b
      join public.salary_records r on r.batch_id = b.id
      group by b.year, b.month, b.status
      order by b.year desc, b.month desc
      limit v_months
    ) t;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.month_key desc), '[]'::jsonb)
    into v_runs
    from (
      select
        r.month_key                                                                    as month_key,
        r.phase                                                                        as phase,
        (r.part1_confirmed_at is not null)                                             as part1_confirmed,
        (r.part2_confirmed_at is not null)                                             as part2_confirmed,
        (r.published_at is not null)                                                   as published,
        r.part2_confirmed_at                                                           as part2_confirmed_at,
        count(d.*) filter (where not coalesce(d.excluded, false))                      as rows_in_run,
        -- Held rows are IN the run but excluded from the payout, so they never reach a bank file.
        -- Finance has to clear them before a month can close, and nothing else on his page would
        -- tell him they exist.
        count(d.*) filter (where coalesce(d.on_hold, false) and not coalesce(d.excluded, false))  as on_hold_count,
        round(coalesce(sum(case when coalesce(d.excluded, false) then 0 else coalesce(d.expenses, 0) end), 0)::numeric, 2)  as expenses_paid,
        round(coalesce(sum(case when coalesce(d.excluded, false) then 0 else coalesce(d.incentive, 0) end), 0)::numeric, 2) as incentive
      from public.automated_payroll_runs r
      left join public.automated_payroll_draft_rows d on d.run_id = r.id
      group by r.month_key, r.phase, r.part1_confirmed_at, r.part2_confirmed_at, r.published_at
      order by r.month_key desc
      limit 6
    ) t;

  select jsonb_build_object(
           'awaitingCount',  count(*) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null),
           'awaitingValue',  round(coalesce(sum(sales_value) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null), 0)::numeric, 2),
           'awaitingOldest', min(decided_at) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null),
           'approvedCount',  count(*) filter (where lower(coalesce(status, '')) = 'approved'),
           'approvedValue',  round(coalesce(sum(sales_value) filter (where lower(coalesce(status, '')) = 'approved'), 0)::numeric, 2),
           'bookedCount',    count(*) filter (where sales_month is not null),
           'bookedValue',    round(coalesce(sum(sales_value) filter (where sales_month is not null), 0)::numeric, 2),
           'injectedCount',  count(*) filter (where sos_batch_id is not null),
           'collectedCount', count(*) filter (where payment_date is not null),
           'paidTotal',      round(coalesce(sum(paid_amount), 0)::numeric, 2),
           'remainingTotal', round(coalesce(sum(remaining_amount), 0)::numeric, 2),
           'pendingCount',   count(*) filter (where lower(coalesce(status, '')) = 'pending_approval'),
           'pendingValue',   round(coalesce(sum(sales_value) filter (where lower(coalesce(status, '')) = 'pending_approval'), 0)::numeric, 2),
           'heldCount',      count(*) filter (where lower(coalesce(status, '')) in ('held', 'expired')),
           'heldValue',      round(coalesce(sum(sales_value) filter (where lower(coalesce(status, '')) in ('held', 'expired')), 0)::numeric, 2),
           'byStatus',       coalesce((
             select jsonb_agg(jsonb_build_object('status', s.status, 'count', s.c, 'value', s.v) order by s.c desc)
             from (
               select lower(coalesce(status, 'unknown')) as status, count(*) as c,
                      round(coalesce(sum(sales_value), 0)::numeric, 2) as v
               from public.direct_order_requests group by 1
             ) s
           ), '[]'::jsonb)
         )
    into v_direct
    from public.direct_order_requests;

  select jsonb_build_object(
           'awaitingMyStep', (
             select count(*)
             from public.marketing_request_approval_steps s
             where v_actor is not null
               and upper(coalesce(s.assigned_hr_id, '')) = upper(v_actor)
               and coalesce(s.is_cc, false) = false
               and lower(coalesce(s.status, '')) = 'current'
           ),
           'approvedCount',   count(*) filter (where lower(coalesce(status, '')) in ('approved', 'active', 'roi_tracking', 'finance_hold')),
           'committedSpend',  round(coalesce(sum(estimated_cost) filter (where lower(coalesce(status, '')) in ('approved', 'active', 'roi_tracking', 'finance_hold')), 0)::numeric, 2),
           'requiredRoi',     round(coalesce(sum(required_roi_value) filter (where lower(coalesce(status, '')) in ('approved', 'active', 'roi_tracking', 'finance_hold')), 0)::numeric, 2),
           'executedCount',   count(*) filter (where executed_at is not null),
           'dueUnexecutedCount', count(*) filter (where lower(coalesce(status, '')) in ('approved', 'active', 'finance_hold') and pay_date is not null and executed_at is null),
           'dueUnexecutedValue', round(coalesce(sum(estimated_cost) filter (where lower(coalesce(status, '')) in ('approved', 'active', 'finance_hold') and pay_date is not null and executed_at is null), 0)::numeric, 2),
           'dueOldest',       min(pay_date) filter (where lower(coalesce(status, '')) in ('approved', 'active', 'finance_hold') and pay_date is not null and executed_at is null),
           'inApprovalCount', count(*) filter (where lower(coalesce(status, '')) = 'pending_approval'),
           'missingPaymentProof', (
             select count(*)
             from public.marketing_requests m
             join public.marketing_request_approval_steps s
               on s.request_id = m.id and s.step_kind = 'finance' and coalesce(s.is_cc, false) = false
             left join public.marketing_request_finance_requirements f on f.request_id = m.id
             where lower(coalesce(m.status, '')) in ('approved', 'active', 'roi_tracking', 'finance_hold')
               and f.money_transfer_proof_storage_path is null
           ),
           'missingInvoice', (
             select count(*)
             from public.marketing_requests m
             join public.marketing_request_approval_steps s
               on s.request_id = m.id and s.step_kind = 'finance' and coalesce(s.is_cc, false) = false
             left join public.marketing_request_finance_requirements f on f.request_id = m.id
             where lower(coalesce(m.status, '')) in ('approved', 'active', 'roi_tracking', 'finance_hold')
               and f.invoice_storage_path is null
           )
         )
    into v_marketing
    from public.marketing_requests;

  select jsonb_build_object(
           'awaitingMyDecision', (
             select count(*)
             from public.v2_vacation_approval_steps s
             join public.v2_vacation_requests v on v.id = s.request_id
             where v_actor is not null
               and upper(coalesce(s.approver_hr_id, '')) = upper(v_actor)
               and lower(coalesce(s.status, '')) = 'pending'
               and lower(coalesce(v.status, '')) in ('pending_manager', 'pending_hr', 'needs_assignment')
           )
         )
    into v_leave;

  return jsonb_build_object(
    'generatedAt',  now(),
    'headcount',    v_headcount,
    'payroll',      jsonb_build_object(
                      'committed', v_committed,
                      'runs',      v_runs,
                      'parts',     v_parts,
                      'channels',  v_channels
                    ),
    'directOrders', v_direct,
    'marketing',    v_marketing,
    'leave',        v_leave
  );
end;
$$;

comment on function public.phx_finance_command_center(text, int) is
  'Finance Manager landing dashboard payload in ONE round trip: headcount, the payout split (first vs second payment, FAB/CIB/Treasury), the direct-order money pipeline, marketing spend/execution/ROI, and his leave queue. Carries NO deduction figures by design.';

revoke execute on function public.phx_finance_command_center(text, int) from public, anon, authenticated;
grant execute on function public.phx_finance_command_center(text, int) to service_role;

notify pgrst, 'reload schema';
