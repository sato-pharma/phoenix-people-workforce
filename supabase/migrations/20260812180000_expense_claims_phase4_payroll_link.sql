-- Outstation & Expenses — Target Architecture, PHASE 4: the payroll contract.
--
-- ADDITIVE. Two functions, wired to nothing. `phx_link_expense_claims_to_payroll` DEFAULTS TO
-- DRY RUN and writes nothing unless explicitly called with p_dry_run => false.
--
-- This replaces `phx_import_approved_expenses_to_payroll`, which:
--   * has NEVER run - it refuses every batch status production actually reaches, so 0 of 360 legacy
--     ledger rows carry `imported_to_payroll_at` while EGP 258,748.50 moved by hand (F-01);
--   * would be DESTRUCTIVE if it ever did run - `SET expenses = coalesce(at.approved_expense, 0)`
--     over a LEFT JOIN zeroes every employee in the batch who has no approved outstation claim.
--     July alone carries EGP 19,354 for 9 such people (F-03).
--
-- THREE RULES, and they are the whole design:
--
--   1. Payroll PULLS. Outstation never pushes. This function is called BY the payroll step.
--   2. A link is the only record of payment. `expense_payroll_links.claim_id` is UNIQUE, so a
--      re-run is a no-op rather than a second payment.
--   3. The write is ADDITIVE - `expenses = expenses + delta`, never `SET`. Non-outstation expenses
--      cannot be destroyed by an outstation operation. F-03 becomes structurally impossible.
--
-- DOUBLE-PAY GUARD. Claims are linked only when their payout period EXACTLY matches the target
-- batch's period, and a closed batch is refused outright. That matters more than it looks: the 70
-- approved claims sitting on payout 2026-07 (EGP 30,027) were already hand-carried into the July
-- payroll - 12 of 14 employees matched to the pound. Linking them would pay them twice. They are
-- protected because 2026-07 is `approved` and this function will not touch a closed batch.
--
-- MISSING SALARY RECORD. A claim whose employee has no salary record in the target batch is
-- returned in `skipped_no_salary_record`, never silently dropped. That is exactly how B-175's
-- EGP 1,849 was lost in July (F-02) - the money had nowhere to land and nothing said so.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Read-only projection. Needs no batch, writes nothing, safe at any time.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_project_expense_payroll(
  p_year  integer,
  p_month integer
)
returns table (
  employee_hr_id text,
  employee_name  text,
  claim_count    bigint,
  payable_egp    numeric,
  has_salary_record boolean
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- Grouped first, THEN the per-employee lookup. A correlated subquery in the same select as the
  -- GROUP BY cannot reference `c.employee_hr_id` - only `lower(c.employee_hr_id)` is grouped, and
  -- Postgres will not match the two. (Caught by Postgres on first apply, 2026-08-12.)
  with agg as (
    select lower(c.employee_hr_id)                                   as hr_key,
           min(c.employee_hr_id)                                     as employee_hr_id,
           min(c.employee_name)                                      as employee_name,
           count(*)                                                  as claim_count,
           round(sum(coalesce(c.approved_total, c.claimed_total)), 2) as payable_egp
    from public.expense_claims c
    where c.status = 'approved'
      and c.payout_year = p_year
      and c.payout_month = p_month
      and coalesce(c.evidence_gate_status, 'complete') in ('complete', 'grandfathered')
      and coalesce(c.workload_gate_status, 'complete') in ('complete', 'grandfathered', 'manual')
      and not exists (select 1 from public.expense_payroll_links l where l.claim_id = c.id)
    group by lower(c.employee_hr_id)
  )
  select a.employee_hr_id, a.employee_name, a.claim_count, a.payable_egp,
         exists (
           select 1
           from public.salary_records r
           join public.salary_batches b on b.id = r.batch_id
           where b.year = p_year and b.month = p_month and lower(r.hr_id) = a.hr_key
         )
  from agg a
  order by 1;
$function$;

revoke execute on function public.phx_project_expense_payroll(integer, integer)
  from public, anon, authenticated;
grant execute on function public.phx_project_expense_payroll(integer, integer) to service_role;

comment on function public.phx_project_expense_payroll(integer, integer) is
  'What outstation would contribute to a payout period, per employee. Read-only, needs no batch. has_salary_record=false is the B-175 failure mode: approved money with nowhere to land.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The link. DRY RUN BY DEFAULT.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_link_expense_claims_to_payroll(
  p_batch_id uuid,
  p_actor_hr_id text,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_batch    public.salary_batches%rowtype;
  v_planned  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_total    numeric := 0;
  v_emps     integer := 0;
  v_claims   integer := 0;
  r          record;
begin
  if p_actor_hr_id is null or btrim(p_actor_hr_id) = '' then
    raise exception 'An actor is required: linking money to payroll must be attributable.'
      using errcode = 'P0001';
  end if;

  select * into v_batch from public.salary_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Payroll batch % was not found.', p_batch_id using errcode = 'P0002';
  end if;

  -- Fail fast and legibly. The salary_records trigger would refuse anyway, but only after the
  -- caller had reason to think the operation was under way.
  if v_batch.status in ('approved', 'locked') then
    raise exception
      'Payroll batch %-% is "%" and cannot receive expense links. Re-opening a closed batch and linking claims whose period was already paid by hand would pay them twice.',
      v_batch.year, lpad(v_batch.month::text, 2, '0'), v_batch.status
      using errcode = 'P0001';
  end if;

  -- Per employee: what is payable, and whether there is a salary record to put it on.
  -- Same shape as the projection: group first, then look up the salary record per employee.
  for r in
    with agg as (
      select lower(c.employee_hr_id)                                    as hr_key,
             min(c.employee_hr_id)                                      as hr_id,
             min(c.employee_name)                                       as employee_name,
             count(*)                                                   as claim_count,
             round(sum(coalesce(c.approved_total, c.claimed_total)), 2) as payable
      from public.expense_claims c
      where c.status = 'approved'
        -- EXACT period match: never sweep an older period into a newer batch.
        and c.payout_year = v_batch.year
        and c.payout_month = v_batch.month
        and coalesce(c.evidence_gate_status, 'complete') in ('complete', 'grandfathered')
        and coalesce(c.workload_gate_status, 'complete') in ('complete', 'grandfathered', 'manual')
        and not exists (select 1 from public.expense_payroll_links l where l.claim_id = c.id)
      group by lower(c.employee_hr_id)
    )
    select a.hr_key, a.hr_id, a.employee_name, a.claim_count, a.payable,
           (select r2.id from public.salary_records r2
             where r2.batch_id = v_batch.id and lower(r2.hr_id) = a.hr_key
             limit 1) as salary_record_id
    from agg a
    order by a.hr_id
  loop
    if r.salary_record_id is null then
      -- Reported, never dropped. This is the B-175 case.
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'employee_hr_id', r.hr_id,
        'employee_name',  r.employee_name,
        'claim_count',    r.claim_count,
        'payable_egp',    r.payable,
        'reason',         'No salary record in this batch - the money has nowhere to land.'
      ));
      continue;
    end if;

    v_planned := v_planned || jsonb_build_array(jsonb_build_object(
      'employee_hr_id', r.hr_id,
      'employee_name',  r.employee_name,
      'claim_count',    r.claim_count,
      'payable_egp',    r.payable
    ));
    v_total  := v_total + r.payable;
    v_emps   := v_emps + 1;
    v_claims := v_claims + r.claim_count;

    if not p_dry_run then
      -- ADDITIVE, never SET. The derived columns move by the same delta so the sheet stays
      -- internally consistent.
      update public.salary_records
      set expenses        = coalesce(expenses, 0)        + r.payable,
          total_additions = coalesce(total_additions, 0) + r.payable,
          second_part     = coalesce(second_part, 0)     + r.payable,
          month_salary    = coalesce(month_salary, 0)    + r.payable
      where id = r.salary_record_id;

      -- One link per claim; UNIQUE(claim_id) makes a re-run a no-op rather than a second payment.
      insert into public.expense_payroll_links
        (claim_id, salary_batch_id, salary_record_id, amount, linked_by_hr_id)
      select c.id, v_batch.id, r.salary_record_id,
             coalesce(c.approved_total, c.claimed_total), p_actor_hr_id
      from public.expense_claims c
      where c.status = 'approved'
        and c.payout_year = v_batch.year
        and c.payout_month = v_batch.month
        and lower(c.employee_hr_id) = r.hr_key
        and coalesce(c.evidence_gate_status, 'complete') in ('complete', 'grandfathered')
        and coalesce(c.workload_gate_status, 'complete') in ('complete', 'grandfathered', 'manual')
        and not exists (select 1 from public.expense_payroll_links l where l.claim_id = c.id);

      -- The claim's own state, and its audit row, in the same transaction.
      insert into public.expense_claim_events (claim_id, actor_hr_id, event_type, message, metadata)
      select c.id, p_actor_hr_id, 'payroll.linked',
             'Linked to payroll ' || v_batch.year || '-' || lpad(v_batch.month::text, 2, '0'),
             jsonb_build_object(
               'salary_batch_id', v_batch.id,
               'salary_record_id', r.salary_record_id,
               'amount', coalesce(c.approved_total, c.claimed_total),
               'from_status', c.status, 'to_status', 'in_payroll')
      from public.expense_claims c
      join public.expense_payroll_links l on l.claim_id = c.id
      where l.salary_batch_id = v_batch.id and lower(c.employee_hr_id) = r.hr_key
        and c.status = 'approved';

      update public.expense_claims c
      set status = 'in_payroll'
      from public.expense_payroll_links l
      where l.claim_id = c.id and l.salary_batch_id = v_batch.id
        and lower(c.employee_hr_id) = r.hr_key and c.status = 'approved';
    end if;
  end loop;

  return jsonb_build_object(
    'dry_run',        p_dry_run,
    'batch',          v_batch.year || '-' || lpad(v_batch.month::text, 2, '0'),
    'batch_status',   v_batch.status,
    'employees',      v_emps,
    'claims',         v_claims,
    'total_egp',      round(v_total, 2),
    'planned',        v_planned,
    'skipped_no_salary_record', v_skipped
  );
end;
$function$;

revoke execute on function public.phx_link_expense_claims_to_payroll(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.phx_link_expense_claims_to_payroll(uuid, text, boolean) to service_role;

comment on function public.phx_link_expense_claims_to_payroll(uuid, text, boolean) is
  'PULL contract: payroll asks outstation what it owes and links it. DRY RUN by default. Additive write (never SET), UNIQUE(claim_id) idempotency, refuses closed batches, and reports employees with no salary record instead of dropping them.';
