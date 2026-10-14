-- finance_command_center_offset_requests_need_no_proof
--
-- WHAT THIS CHANGES: phx_finance_command_center's marketing.missingPaymentProof no longer counts a
-- request that has been settled against a direct order (a row in direct_order_marketing_offsets).
-- Nothing else in the function changes: the body below is the live definition (20260922200000)
-- with that one extra predicate and its comment.
--
-- WHY: such a request is paid by the hospital keeping the money out of its own payment, so no
-- transfer ever exists to prove. Left alone it would sit in the Finance Manager's "missing payment
-- proof" tile for ever, asking for a file that cannot exist.
--
-- ROLLBACK: re-apply 20260922200000_finance_command_center_committed_trend_one_row_per_month.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Not destructive and not bulk: it replaces one read-only function.

CREATE OR REPLACE FUNCTION public.phx_finance_command_center(p_actor_hr_id text DEFAULT NULL::text, p_trend_months integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '20s'
AS $function$
declare
  v_actor      text := nullif(btrim(coalesce(p_actor_hr_id, '')), '');
  v_months     int  := greatest(1, least(24, coalesce(p_trend_months, 6)));
  -- The current Cairo month as a HALF-OPEN interval [start, next). Resolved once so the two
  -- leaver counters below cannot drift apart, and so neither can be written with only one end.
  v_month_start date := date_trunc('month', (now() at time zone 'Africa/Cairo'))::date;
  v_month_next  date := (date_trunc('month', (now() at time zone 'Africa/Cairo')) + interval '1 month')::date;
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
  --
  -- BOTH ENDS, always. A notice period means these columns are routinely dated into the FUTURE,
  -- so a lower bound on its own quietly turns "this month" into "from this month onward".
  select jsonb_build_object(
           'activeEmployees',    count(*) filter (where lower(coalesce(employment_status, '')) in ('active', 'on_leave')),
           'payrollEligible',    count(*) filter (where payroll_eligible),
           'standingNet',        round(coalesce(sum(net_salary)   filter (where payroll_eligible), 0)::numeric, 2),
           'standingGross',      round(coalesce(sum(gross_salary) filter (where payroll_eligible), 0)::numeric, 2),
           'resignedThisMonth',  count(*) filter (where resignation_date  >= v_month_start and resignation_date  < v_month_next),
           'leavingThisMonth',   count(*) filter (where last_working_date >= v_month_start and last_working_date < v_month_next),
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
  --
  -- ONE ROW PER MONTH, and the grouping key says so. `status` is a batch ATTRIBUTE, not part of
  -- the period this trend is keyed on, so it is aggregated rather than grouped: three consumers
  -- break silently the moment a month yields two rows — the chart keys its bars on `period`, the
  -- month-over-month delta chain compares each entry with the one before it, and the "Net payroll"
  -- tile reads the LAST entry. salary_batches carries a UNIQUE index on (year, month), so this was
  -- safe in practice — but it was safe because of a constraint declared in another file, which is
  -- not something a money figure should depend on silently.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.period), '[]'::jsonb)
    into v_committed
    from (
      select
        to_char(make_date(b.year, b.month, 1), 'YYYY-MM')            as period,
        -- Exact today (one batch per month), and honest if that ever stops being true: two
        -- statuses in one month read "approved + locked" rather than silently picking one.
        string_agg(distinct b.status, ' + ' order by b.status)       as status,
        count(r.*)                                                   as employees,
        round(coalesce(sum(r.net_salary), 0)::numeric, 2)            as net,
        round(coalesce(sum(r.gross_salary), 0)::numeric, 2)          as gross
      from public.salary_batches b
      join public.salary_records r on r.batch_id = b.id
      group by b.year, b.month
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
               -- A request settled against a direct order's debt moved no money, so there is no
               -- transfer to prove. The offset row is its own record (direct_order_marketing_offsets).
               and not exists (select 1 from public.direct_order_marketing_offsets o where o.marketing_request_id = m.id)
           ),
           'missingInvoice', (
             select count(*)
             from public.marketing_requests m
             join public.marketing_request_approval_steps s
               on s.request_id = m.id and s.step_kind = 'finance' and coalesce(s.is_cc, false) = false
             left join public.marketing_request_finance_requirements f on f.request_id = m.id
             where lower(coalesce(m.status, '')) in ('approved', 'active', 'roi_tracking', 'finance_hold')
               and f.invoice_storage_path is null
           ),
           -- The three below are the ONLY figures on this page that read invoice_deadline_date.
           -- See the PREDICATE PARITY note in the header before changing either condition.
           'invoiceOverdueCount', (
             select count(*)
             from public.marketing_request_finance_requirements f
             where lower(coalesce(f.invoice_status, '')) = 'pending'
               and f.invoice_deadline_date is not null
               and f.invoice_deadline_date < (now() at time zone 'Africa/Cairo')::date
           ),
           'invoiceOverdueValue', (
             select round(coalesce(sum(m.estimated_cost), 0)::numeric, 2)
             from public.marketing_request_finance_requirements f
             join public.marketing_requests m on m.id = f.request_id
             where lower(coalesce(f.invoice_status, '')) = 'pending'
               and f.invoice_deadline_date is not null
               and f.invoice_deadline_date < (now() at time zone 'Africa/Cairo')::date
           ),
           -- The deadline that has been outstanding longest -- what makes the queue's AGE readable
           -- without opening it, the same job dueOldest does for the unexecuted queue beside it.
           'invoiceOverdueOldest', (
             select min(f.invoice_deadline_date)
             from public.marketing_request_finance_requirements f
             where lower(coalesce(f.invoice_status, '')) = 'pending'
               and f.invoice_deadline_date is not null
               and f.invoice_deadline_date < (now() at time zone 'Africa/Cairo')::date
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
$function$;

-- The tail is reproduced verbatim from 20260830003000 so this file stands alone. CREATE OR REPLACE
-- keeps the existing ACL and comment, so re-stating them changes nothing on a database that already
-- has the function — but a replay onto a FRESH database would otherwise leave EXECUTE with PUBLIC.
comment on function public.phx_finance_command_center(text, int) is
  'Finance Manager landing dashboard payload in ONE round trip: headcount, the payout split (first vs second payment, FAB/CIB/Treasury), the direct-order money pipeline, marketing spend/execution/ROI including invoices past their deadline, and his leave queue. Carries NO deduction figures by design.';

revoke execute on function public.phx_finance_command_center(text, int) from public, anon, authenticated;
grant execute on function public.phx_finance_command_center(text, int) to service_role;

notify pgrst, 'reload schema';
