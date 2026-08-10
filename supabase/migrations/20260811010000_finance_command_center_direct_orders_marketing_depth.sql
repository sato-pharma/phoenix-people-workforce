-- Finance Command Center, v2 — refocus on direct orders and marketing requests.
--
-- Owner instruction (2026-08-10): drop the expenses and deductions sections, and go deep on the
-- two modules he actually owns end to end — direct orders and marketing requests — showing every
-- relevant field "even if empty, no data now, tomorrow will be populated."
--
-- That last clause is the design rule for this version. Both modules are mid-lifecycle: the
-- receivables columns on a direct order (payment_date / paid_amount / remaining_amount) are
-- populated on 0 of 24 rows today, and exactly one marketing request exists. A dashboard that
-- hides a zero teaches its reader the field does not exist; these are rendered as real zero-states
-- so the pipeline is legible before it fills.
--
-- What changed against 20260810170000:
--   * `outstation` block REMOVED — the expenses section is gone from the page, so computing it
--     was pure cost. (Deductions were never read from deductions_candidates and still are not;
--     see the header of the previous migration for the 1.4%-of-estimate measurement that rule
--     exists to prevent. The payroll block keeps its COMMITTED deduction figures, which the owner
--     asked for explicitly and which come from payroll, not from the deductions module.)
--   * `directOrders` gains the full money pipeline: approved value, booked, injected into Source
--     of Sales, collected, paid vs still outstanding, and held exposure.
--   * `marketing` gains committed spend, ROI commitment, execution state, and the "approved with a
--     pay date but not executed" queue — the one that actually means money is due.
--
-- Same guarantees as v1: one round trip, statement_timeout in the CREATE header (a later
-- ALTER is silently dropped by the next CREATE OR REPLACE), and EXECUTE revoked from PUBLIC then
-- re-granted to service_role only.

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
  v_committed  jsonb;
  v_runs       jsonb;
  v_direct     jsonb;
  v_marketing  jsonb;
  v_leave      jsonb;
begin
  select jsonb_build_object(
           'activeEmployees',   count(*) filter (where lower(coalesce(employment_status, '')) in ('active', 'on_leave')),
           'payrollEligible',   count(*) filter (where payroll_eligible),
           'standingNet',       round(coalesce(sum(net_salary)   filter (where payroll_eligible), 0)::numeric, 2),
           'standingGross',     round(coalesce(sum(gross_salary) filter (where payroll_eligible), 0)::numeric, 2)
         )
    into v_headcount
    from public.employees;

  -- Committed payroll. Deductions here are what payroll CHARGED (salary_records), never what a
  -- detection engine proposed.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.period), '[]'::jsonb)
    into v_committed
    from (
      select
        to_char(make_date(b.year, b.month, 1), 'YYYY-MM')                         as period,
        b.status                                                                   as status,
        count(r.*)                                                                 as employees,
        round(coalesce(sum(r.net_salary), 0)::numeric, 2)                          as net,
        round(coalesce(sum(r.gross_salary), 0)::numeric, 2)                        as gross,
        round(coalesce(sum(r.total_deductions), 0)::numeric, 2)                    as deductions,
        round(coalesce(sum(r.governmental_deductions), 0)::numeric, 2)             as governmental,
        round(coalesce(sum(r.crm), 0)::numeric, 2)                                 as crm,
        round(coalesce(sum(r.finger_print), 0)::numeric, 2)                        as fingerprint,
        round(coalesce(sum(r.unpaid_vacations), 0)::numeric, 2)                    as unpaid_vacation,
        round(coalesce(sum(r.loans), 0)::numeric, 2)                               as loans,
        round(coalesce(sum(r.other_deductions), 0)::numeric, 2)                    as other
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
        round(coalesce(sum(
          case when coalesce(d.excluded, false) then 0 else
            coalesce(d.p1od_crm_value, 0) + coalesce(d.fingerprint_value, 0)
            + coalesce(d.p1od_vacation_value, 0) + coalesce(d.p1od_no_record_value, 0)
            + coalesce(d.p1od_loan_value, 0) + coalesce(d.p1od_other_value, 0)
            + coalesce(d.special_deduction_value, 0) + coalesce(d.manual_other_deductions, 0)
          end), 0)::numeric, 2)                                                        as decided_deductions,
        round(coalesce(sum(case when coalesce(d.excluded, false) then 0 else coalesce(d.expenses, 0) end), 0)::numeric, 2)  as expenses_paid,
        round(coalesce(sum(case when coalesce(d.excluded, false) then 0 else coalesce(d.incentive, 0) end), 0)::numeric, 2) as incentive
      from public.automated_payroll_runs r
      left join public.automated_payroll_draft_rows d on d.run_id = r.id
      group by r.month_key, r.phase, r.part1_confirmed_at, r.part2_confirmed_at, r.published_at
      order by r.month_key desc
      limit 6
    ) t;

  -- ── Direct orders: the full money pipeline ─────────────────────────────────
  --
  --   approved -> booked into a sales month -> injected into Source of Sales
  --            -> collected -> paid, leaving an outstanding balance
  --
  -- Only the first hop is his exclusive duty (canSetDirectOrderSalesMonth admits B-185 and a
  -- System Admin and nobody else), but the rest is the receivable that duty creates, so the page
  -- shows the whole chain. `awaiting*` keeps the predicate identical to showsAwaitingFinanceMonth
  -- in src/lib/direct-orders/types.ts — one definition of "unbooked", two languages, pinned by
  -- tests/finance-command-center.test.ts.
  select jsonb_build_object(
           'awaitingCount',  count(*) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null),
           'awaitingValue',  round(coalesce(sum(sales_value) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null), 0)::numeric, 2),
           'awaitingOldest', min(decided_at) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null),
           'approvedCount',  count(*) filter (where lower(coalesce(status, '')) = 'approved'),
           'approvedValue',  round(coalesce(sum(sales_value) filter (where lower(coalesce(status, '')) = 'approved'), 0)::numeric, 2),
           'bookedCount',    count(*) filter (where sales_month is not null),
           'bookedValue',    round(coalesce(sum(sales_value) filter (where sales_month is not null), 0)::numeric, 2),
           -- Injected = the order's value has actually reached Source of Sales.
           'injectedCount',  count(*) filter (where sos_batch_id is not null),
           -- Receivables. Every one of these is 0 today and fills as collection begins.
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

  -- ── Marketing requests: committed spend, execution, and ROI ────────────────
  --
  -- His rung is `finance_execution` — the terminal step, activated 2026-08-10. `awaitingMyStep`
  -- is assignment-scoped because authority here is assignment-based, never role-based
  -- (assertMarketingStepAssignedToActor).
  --
  -- `dueUnexecuted` is the money question: approved, carrying a pay date, and never executed. It
  -- does NOT require a finance step to exist, deliberately — a request approved before the rung
  -- was switched on is still spend the company owes, and hiding it because of a workflow
  -- technicality would hide a real payable.
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
           -- Evidence backlogs stay scoped to requests that actually carry a finance step: counting
           -- every approved request instead reported the whole historical archive as missing proof
           -- (101 of 101 on staging, against a true 0).
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
    'payroll',      jsonb_build_object('committed', v_committed, 'runs', v_runs),
    'directOrders', v_direct,
    'marketing',    v_marketing,
    'leave',        v_leave
  );
end;
$$;

comment on function public.phx_finance_command_center(text, int) is
  'Finance Manager landing dashboard payload in ONE round trip: payroll actuals, the direct-order money pipeline, marketing spend/execution/ROI, and his leave queue. Deduction figures come from committed payroll (salary_records / automated_payroll_draft_rows) and NEVER from candidate estimates.';

revoke execute on function public.phx_finance_command_center(text, int) from public, anon, authenticated;
grant execute on function public.phx_finance_command_center(text, int) to service_role;

notify pgrst, 'reload schema';
