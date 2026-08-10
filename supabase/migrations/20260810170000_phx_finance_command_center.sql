-- Finance Command Center — one round trip for the Finance Manager's landing dashboard.
--
-- Ahmed El Maraghy (B-185) landed on /admin/outstation/expense-command, one module of a job that
-- spans payroll, direct orders, marketing execution, outstation expenses and leave. This function
-- backs his overview. It exists as ONE `returns jsonb` call for a specific reason: the CEO Command
-- Center is the design reference but NOT the performance one — its Phase A fans out, transitively,
-- into the low hundreds of round trips. Assembling the whole payload server-side keeps the page at
-- a single Amsterdam->Frankfurt crossing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEDUCTION RULE — the reason this function exists rather than a TS fan-out.
--
-- Every deduction figure here comes from what payroll ACTUALLY COMMITTED:
--   * published/locked months  -> public.salary_records (crm, finger_print, unpaid_vacations,
--                                 loans, other_deductions, total_deductions)
--   * the in-flight run        -> public.automated_payroll_draft_rows (the p1od_* owner decisions,
--                                 fingerprint_value, special_deduction_value, manual_other_deductions)
--
-- It must NEVER read public.deductions_candidates. That table holds what the detection engines
-- SUGGEST, not what HR applied, and the gap is not marginal — measured on production 2026-08-10:
--
--            July 2026        candidates      actually committed
--            CRM              1,257,693.45    0.00
--            all categories   1,833,169.35    25,577.65     (1.4% of the estimate)
--
-- src/lib/deductions/calculations.ts:100-102 records the same class of error biting once already
-- ("HR ended up reading a number ~3x larger than what publish would actually commit"). A finance
-- manager's landing page is the worst possible place to repeat it, so the rule is mechanical and
-- tests/finance-command-center.test.ts asserts this file never names that table.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `security definer` + an explicit revoke/grant pair, per scripts/check-migrations.mjs rule 4:
-- a function born in `public` inherits EXECUTE for PUBLIC, and anon/authenticated are members, so
-- revoking only those two is a no-op. Revoking PUBLIC on a default ACL also strips service_role,
-- hence the explicit re-grant.
--
-- `set statement_timeout to '20s'` lives in the CREATE header deliberately: a later
-- `ALTER FUNCTION ... SET` is silently dropped by the next CREATE OR REPLACE, which is exactly how
-- three protected RPCs lost their timeout and started returning HTTP 500 at the 8s authenticator
-- default. tests/report-rpc-guardrails.test.ts replays every migration to prove it survives.

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
  v_outstation jsonb;
  v_marketing  jsonb;
  v_leave      jsonb;
begin
  -- ── Headcount / standing payroll cost ──────────────────────────────────────
  -- `payroll_eligible` is the population payroll actually pays, which is NOT the same as
  -- `employment_status = 'active'` (a resigned employee can still owe a final settlement).
  -- Both are reported so the page never implies one is the other.
  select jsonb_build_object(
           'activeEmployees',   count(*) filter (where lower(coalesce(employment_status, '')) in ('active', 'on_leave')),
           'payrollEligible',   count(*) filter (where payroll_eligible),
           'standingNet',       round(coalesce(sum(net_salary)   filter (where payroll_eligible), 0)::numeric, 2),
           'standingGross',     round(coalesce(sum(gross_salary) filter (where payroll_eligible), 0)::numeric, 2)
         )
    into v_headcount
    from public.employees;

  -- ── Committed payroll: the ACTUAL deductions, per closed batch ──────────────
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

  -- ── Automated payroll runs: phase + the deductions HR has actually decided ──
  -- Excluded rows are dropped: they are not in the run and must not inflate a total.
  -- `phase`/confirm timestamps are the sanctioned progress signal — getRunForPeriod is
  -- Super-Admin-only (assertAutomatedPayrollHrActor), so the Finance Manager can never read it.
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

  -- ── Direct orders ──────────────────────────────────────────────────────────
  -- `awaiting` is the Finance Manager's own, exclusive duty: canSetDirectOrderSalesMonth admits
  -- B-185 and Super Admin and nobody else. The predicate is deliberately identical to
  -- showsAwaitingFinanceMonth() in src/lib/direct-orders/types.ts — one definition of "unbooked",
  -- two languages, and tests/finance-command-center.test.ts asserts they stay in step.
  select jsonb_build_object(
           'awaitingCount',    count(*) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null),
           'awaitingValue',    round(coalesce(sum(sales_value) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null), 0)::numeric, 2),
           'awaitingOldest',   min(decided_at) filter (where lower(coalesce(status, '')) = 'approved' and sales_month is null),
           'bookedCount',      count(*) filter (where sales_month is not null),
           'byStatus',         coalesce((
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

  -- ── Outstation expenses ────────────────────────────────────────────────────
  -- He reads this workspace but holds no `outstation:approve` (executionOnlyOutstationRoles), so
  -- the page must show the backlog and its AGE without ever offering a decision control.
  select jsonb_build_object(
           'pendingCount',   count(*) filter (where lower(coalesce(status, '')) = 'submitted'),
           'pendingClaimed', round(coalesce(sum(claimed_total_amount) filter (where lower(coalesce(status, '')) = 'submitted'), 0)::numeric, 2),
           'pendingOldest',  min(created_at) filter (where lower(coalesce(status, '')) = 'submitted'),
           'approvedCount',  count(*) filter (where lower(coalesce(status, '')) = 'approved'),
           'approvedValue',  round(coalesce(sum(claimed_total_amount) filter (where lower(coalesce(status, '')) = 'approved'), 0)::numeric, 2),
           'byStatus',       coalesce((
             select jsonb_agg(jsonb_build_object('status', s.status, 'count', s.c, 'value', s.v) order by s.c desc)
             from (
               select lower(coalesce(status, 'unknown')) as status, count(*) as c,
                      round(coalesce(sum(claimed_total_amount), 0)::numeric, 2) as v
               from public.outstation_expense_requests group by 1
             ) s
           ), '[]'::jsonb)
         )
    into v_outstation
    from public.outstation_expense_requests;

  -- ── Marketing: his finance_execution rung + the payment-proof backlog ───────
  -- Authority here is assignment-based (assertMarketingStepAssignedToActor), never role-based,
  -- so an actor-scoped count is the honest one. `is_cc` steps are advisory and never gate.
  select jsonb_build_object(
           'awaitingMyStep', (
             select count(*)
             from public.marketing_request_approval_steps s
             where v_actor is not null
               and upper(coalesce(s.assigned_hr_id, '')) = upper(v_actor)
               and coalesce(s.is_cc, false) = false
               and lower(coalesce(s.status, '')) = 'current'
           ),
           -- Both backlogs are scoped to requests that actually CARRY a finance step. The
           -- `finance_execution` rung was only activated on 2026-08-10, so every request approved
           -- before that never had one — counting them would report the entire historical archive
           -- as "missing payment proof" on day one (measured: 101 of 101 on staging). Joining the
           -- step is what makes this a real backlog instead of a census.
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
    into v_marketing;

  -- ── Leave awaiting his decision ────────────────────────────────────────────
  -- He manages three head-office staff. A step row is the gate (getPendingVacationApprovalStepForActor),
  -- so counting assigned pending steps is exactly what he can act on — never the company backlog.
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
    'generatedAt', now(),
    'headcount',   v_headcount,
    'payroll',     jsonb_build_object('committed', v_committed, 'runs', v_runs),
    'directOrders', v_direct,
    'outstation',  v_outstation,
    'marketing',   v_marketing,
    'leave',       v_leave
  );
end;
$$;

comment on function public.phx_finance_command_center(text, int) is
  'Finance Manager landing dashboard payload in ONE round trip. Deduction figures come from committed payroll (salary_records / automated_payroll_draft_rows) and NEVER from deductions_candidates — see the header comment for the measured 1.4%-of-estimate gap.';

-- Rule 4 of scripts/check-migrations.mjs: revoke from PUBLIC (anon/authenticated inherit through
-- it, so revoking only those two does nothing), then re-grant explicitly — revoking PUBLIC on a
-- default ACL strips service_role too. The app calls this through getSupabaseAdmin(), so
-- service_role is the only grantee it needs.
revoke execute on function public.phx_finance_command_center(text, int) from public, anon, authenticated;
grant execute on function public.phx_finance_command_center(text, int) to service_role;

notify pgrst, 'reload schema';
