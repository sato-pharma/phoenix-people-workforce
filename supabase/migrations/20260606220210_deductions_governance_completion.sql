-- Deductions Governance completion.
--
-- Scope:
-- - HR decision applied values and payroll-column mapping.
-- - Immutable monthly approved-deductions snapshots.
-- - Employee comments on published deductions.
-- - Payroll import lineage and service-role-only RPC.
--
-- Safety:
-- - No automatic payroll mutation is triggered from governance tables.
-- - Payroll is updated only by the explicit phx_import_deductions_governance_to_payroll RPC.
-- - Tables remain service_role-only under RLS.

alter table public.deduction_decisions
  add column if not exists applied_deduction_value numeric(14, 2) null,
  add column if not exists applied_amount numeric(14, 2) null,
  add column if not exists payroll_column text null;

alter table public.deduction_decisions
  drop constraint if exists deduction_decisions_applied_value_non_negative,
  add constraint deduction_decisions_applied_value_non_negative
    check (applied_deduction_value is null or applied_deduction_value >= 0);

alter table public.deduction_decisions
  drop constraint if exists deduction_decisions_applied_amount_non_negative,
  add constraint deduction_decisions_applied_amount_non_negative
    check (applied_amount is null or applied_amount >= 0);

alter table public.deduction_decisions
  drop constraint if exists deduction_decisions_payroll_column_check,
  add constraint deduction_decisions_payroll_column_check
    check (payroll_column is null or payroll_column in ('crm', 'finger_print', 'unpaid_vacations'));

alter table public.deduction_decisions
  drop constraint if exists deduction_decisions_payroll_handoff_status_check,
  add constraint deduction_decisions_payroll_handoff_status_check check (payroll_handoff_status in (
    'Not pushed',
    'Export only',
    'Pending integration',
    'Imported to Payroll'
  ));

create table if not exists public.deduction_monthly_summaries (
  id uuid primary key default gen_random_uuid(),
  month_key text not null,
  month integer not null,
  year integer not null,
  status text not null default 'finalized',
  finalized_by text not null,
  finalized_at timestamptz not null default now(),
  candidate_count integer not null default 0,
  employee_count integer not null default 0,
  total_days numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  source_counts jsonb not null default '{}'::jsonb,
  notes text null,
  created_at timestamptz not null default now(),
  constraint deduction_monthly_summaries_month_range check (month between 1 and 12),
  constraint deduction_monthly_summaries_year_range check (year between 2000 and 2100),
  constraint deduction_monthly_summaries_status_check check (status in ('finalized', 'superseded')),
  constraint deduction_monthly_summaries_month_key_not_blank check (btrim(month_key) <> ''),
  constraint deduction_monthly_summaries_finalized_by_not_blank check (btrim(finalized_by) <> ''),
  constraint deduction_monthly_summaries_counts_non_negative check (
    candidate_count >= 0 and employee_count >= 0 and total_days >= 0 and total_amount >= 0
  )
);

create index if not exists deduction_monthly_summaries_month_key_finalized_idx
  on public.deduction_monthly_summaries (month_key, finalized_at desc);

create table if not exists public.deduction_monthly_summary_lines (
  id uuid primary key default gen_random_uuid(),
  summary_id uuid not null references public.deduction_monthly_summaries(id) on delete cascade,
  candidate_id uuid not null references public.deduction_candidates(id) on delete restrict,
  decision_id uuid not null references public.deduction_decisions(id) on delete restrict,
  employee_code text not null,
  employee_hr_id_compact text not null,
  employee_name text null,
  month_key text not null,
  source_module text not null,
  deduction_type text not null,
  payroll_column text not null,
  deduction_unit text not null,
  original_deduction_value numeric(14, 2) not null default 0,
  applied_deduction_value numeric(14, 2) not null default 0,
  applied_amount numeric(14, 2) not null default 0,
  dates jsonb not null default '[]'::jsonb,
  reason text null,
  hr_note text null,
  created_at timestamptz not null default now(),
  constraint deduction_monthly_summary_lines_column_check
    check (payroll_column in ('crm', 'finger_print', 'unpaid_vacations')),
  constraint deduction_monthly_summary_lines_source_module_check check (source_module in (
    'FIELD_WORKFORCE',
    'ATTENDANCE_DEVICE',
    'VACATION',
    'MANUAL_HR',
    'DISCIPLINARY',
    'PAYROLL_ADJUSTMENT',
    'EXPENSE_RECOVERY',
    'OTHER'
  )),
  constraint deduction_monthly_summary_lines_values_non_negative check (
    original_deduction_value >= 0 and applied_deduction_value >= 0 and applied_amount >= 0
  ),
  constraint deduction_monthly_summary_lines_employee_code_not_blank check (btrim(employee_code) <> ''),
  constraint deduction_monthly_summary_lines_month_key_not_blank check (btrim(month_key) <> ''),
  constraint deduction_monthly_summary_lines_unique_decision unique (summary_id, decision_id)
);

create index if not exists deduction_monthly_summary_lines_summary_idx
  on public.deduction_monthly_summary_lines (summary_id);

create index if not exists deduction_monthly_summary_lines_employee_idx
  on public.deduction_monthly_summary_lines (employee_hr_id_compact, month_key);

create index if not exists deduction_monthly_summary_lines_column_idx
  on public.deduction_monthly_summary_lines (month_key, payroll_column);

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'deduction_decisions'
      and constraint_name = 'deduction_decisions_finalized_summary_id_fkey'
  ) then
    alter table public.deduction_decisions
      add column if not exists finalized_summary_id uuid null;

    alter table public.deduction_decisions
      add constraint deduction_decisions_finalized_summary_id_fkey
      foreign key (finalized_summary_id)
      references public.deduction_monthly_summaries(id)
      on delete set null;
  end if;
end
$$;

create index if not exists deduction_decisions_finalized_summary_idx
  on public.deduction_decisions (finalized_summary_id);

create table if not exists public.deduction_comments (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.deduction_candidates(id) on delete cascade,
  author_login_id text not null default 'system',
  author_hr_id text null,
  author_role text null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint deduction_comments_body_not_blank check (btrim(body) <> ''),
  constraint deduction_comments_author_not_blank check (btrim(author_login_id) <> '')
);

create index if not exists deduction_comments_candidate_created_idx
  on public.deduction_comments (candidate_id, created_at desc);

create table if not exists public.deduction_payroll_import_jobs (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null unique,
  summary_id uuid not null references public.deduction_monthly_summaries(id) on delete restrict,
  batch_id uuid references public.salary_batches(id) on delete set null,
  month_key text not null,
  actor_login_id text not null default 'system',
  imported_employees integer null,
  imported_total numeric(14, 2) null,
  status text not null default 'pending',
  matched_employees jsonb not null default '[]'::jsonb,
  unmatched_employees jsonb not null default '[]'::jsonb,
  error_message text null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint deduction_payroll_import_jobs_status_check check (status in ('pending', 'completed', 'failed')),
  constraint deduction_payroll_import_jobs_month_key_not_blank check (btrim(month_key) <> ''),
  constraint deduction_payroll_import_jobs_actor_not_blank check (btrim(actor_login_id) <> '')
);

create index if not exists deduction_payroll_import_jobs_summary_idx
  on public.deduction_payroll_import_jobs (summary_id);

create index if not exists deduction_payroll_import_jobs_month_created_idx
  on public.deduction_payroll_import_jobs (month_key, created_at desc);

alter table public.deduction_monthly_summaries enable row level security;
alter table public.deduction_monthly_summary_lines enable row level security;
alter table public.deduction_comments enable row level security;
alter table public.deduction_payroll_import_jobs enable row level security;

revoke all on table public.deduction_monthly_summaries from public, anon, authenticated;
revoke all on table public.deduction_monthly_summary_lines from public, anon, authenticated;
revoke all on table public.deduction_comments from public, anon, authenticated;
revoke all on table public.deduction_payroll_import_jobs from public, anon, authenticated;

grant select, insert, update, delete on table public.deduction_monthly_summaries to service_role;
grant select, insert, update, delete on table public.deduction_monthly_summary_lines to service_role;
grant select, insert, update, delete on table public.deduction_comments to service_role;
grant select, insert, update, delete on table public.deduction_payroll_import_jobs to service_role;

drop policy if exists deduction_monthly_summaries_service_role_all
  on public.deduction_monthly_summaries;
create policy deduction_monthly_summaries_service_role_all
  on public.deduction_monthly_summaries
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists deduction_monthly_summary_lines_service_role_all
  on public.deduction_monthly_summary_lines;
create policy deduction_monthly_summary_lines_service_role_all
  on public.deduction_monthly_summary_lines
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists deduction_comments_service_role_all
  on public.deduction_comments;
create policy deduction_comments_service_role_all
  on public.deduction_comments
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists deduction_payroll_import_jobs_service_role_all
  on public.deduction_payroll_import_jobs;
create policy deduction_payroll_import_jobs_service_role_all
  on public.deduction_payroll_import_jobs
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.phx_import_deductions_governance_to_payroll(
  p_summary_id uuid,
  p_import_job_id uuid default gen_random_uuid(),
  p_actor_login_id text default 'system'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_summary public.deduction_monthly_summaries%rowtype;
  v_batch public.salary_batches%rowtype;
  v_existing_job public.deduction_payroll_import_jobs%rowtype;
  v_imported_employees integer := 0;
  v_imported_total numeric := 0;
  v_matched_employees jsonb := '[]'::jsonb;
  v_unmatched_employees jsonb := '[]'::jsonb;
begin
  if p_summary_id is null then
    raise exception 'A finalized deductions summary is required.' using errcode = 'P0001';
  end if;

  select *
  into v_summary
  from public.deduction_monthly_summaries
  where id = p_summary_id
  for update;

  if not found then
    raise exception 'Deductions summary % was not found.', p_summary_id using errcode = 'P0001';
  end if;

  if v_summary.status <> 'finalized' then
    raise exception 'Deductions summary % is not finalized.', p_summary_id using errcode = 'P0001';
  end if;

  if p_import_job_id is not null then
    select *
    into v_existing_job
    from public.deduction_payroll_import_jobs
    where import_job_id = p_import_job_id
    for update;

    if found and v_existing_job.status = 'completed' then
      return jsonb_build_object(
        'import_job_id', p_import_job_id,
        'idempotent_replay', true,
        'imported_employees', coalesce(v_existing_job.imported_employees, 0),
        'imported_total', coalesce(v_existing_job.imported_total, 0),
        'matched_employees', v_existing_job.matched_employees,
        'unmatched_employees', v_existing_job.unmatched_employees,
        'target_batch_id', v_existing_job.batch_id,
        'target_batch_month', v_summary.month,
        'target_batch_year', v_summary.year
      );
    end if;
  end if;

  select *
  into v_batch
  from public.salary_batches
  where month = v_summary.month
    and year = v_summary.year
  order by created_at desc, id desc
  limit 1
  for update;

  if not found then
    raise exception 'No payroll batch exists for deductions month %.', v_summary.month_key using errcode = 'P0001';
  end if;

  if v_batch.status not in ('part1_paid', 'adjustments_open', 'part2_ready', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot import deductions while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  with line_totals as (
    select
      lower(employee_code) as normalized_hr_id,
      min(employee_code) as employee_code,
      min(employee_name) as employee_name,
      sum(applied_amount) filter (where payroll_column = 'crm')::numeric(14, 2) as crm_total,
      sum(applied_amount) filter (where payroll_column = 'finger_print')::numeric(14, 2) as finger_print_total,
      sum(applied_amount) filter (where payroll_column = 'unpaid_vacations')::numeric(14, 2) as unpaid_vacations_total,
      sum(applied_amount)::numeric(14, 2) as total_amount
    from public.deduction_monthly_summary_lines
    where summary_id = p_summary_id
    group by lower(employee_code)
  ),
  unmatched as (
    select
      lt.employee_code,
      lt.employee_name,
      lt.total_amount
    from line_totals lt
    where not exists (
      select 1
      from public.salary_records sr
      where sr.batch_id = v_batch.id
        and (
          lower(sr.hr_id) = lt.normalized_hr_id
          or lower(coalesce(sr.employee_code, '')) = lt.normalized_hr_id
        )
    )
  )
  select coalesce(jsonb_agg(to_jsonb(unmatched) order by employee_code), '[]'::jsonb)
  into v_unmatched_employees
  from unmatched;

  if jsonb_array_length(v_unmatched_employees) > 0 then
    raise exception 'Deductions import has unmatched payroll employees for month %.', v_summary.month_key using errcode = 'P0001';
  end if;

  if p_import_job_id is not null then
    insert into public.deduction_payroll_import_jobs (
      import_job_id,
      summary_id,
      batch_id,
      month_key,
      actor_login_id,
      status,
      unmatched_employees,
      created_at
    ) values (
      p_import_job_id,
      p_summary_id,
      v_batch.id,
      v_summary.month_key,
      coalesce(nullif(p_actor_login_id, ''), 'system'),
      'pending',
      v_unmatched_employees,
      now()
    )
    on conflict (import_job_id) do update
      set status = 'pending',
          summary_id = excluded.summary_id,
          batch_id = excluded.batch_id,
          month_key = excluded.month_key,
          actor_login_id = excluded.actor_login_id,
          unmatched_employees = excluded.unmatched_employees,
          created_at = now(),
          error_message = null;
  end if;

  begin
    with line_totals as (
      select
        lower(employee_code) as normalized_hr_id,
        min(employee_code) as employee_code,
        sum(applied_amount) filter (where payroll_column = 'crm')::numeric(14, 2) as crm_total,
        sum(applied_amount) filter (where payroll_column = 'finger_print')::numeric(14, 2) as finger_print_total,
        sum(applied_amount) filter (where payroll_column = 'unpaid_vacations')::numeric(14, 2) as unpaid_vacations_total,
        sum(applied_amount)::numeric(14, 2) as total_amount
      from public.deduction_monthly_summary_lines
      where summary_id = p_summary_id
      group by lower(employee_code)
    ),
    target_rows as (
      select
        sr.id,
        sr.hr_id,
        coalesce(sr.crm, 0)::numeric as old_crm,
        coalesce(sr.finger_print, 0)::numeric as old_finger_print,
        coalesce(sr.unpaid_vacations, 0)::numeric as old_unpaid_vacations,
        coalesce(lt.crm_total, 0)::numeric as new_crm,
        coalesce(lt.finger_print_total, 0)::numeric as new_finger_print,
        coalesce(lt.unpaid_vacations_total, 0)::numeric as new_unpaid_vacations,
        coalesce(lt.total_amount, 0)::numeric as new_total_amount
      from public.salary_records sr
      left join line_totals lt
        on (
          lower(sr.hr_id) = lt.normalized_hr_id
          or lower(coalesce(sr.employee_code, '')) = lt.normalized_hr_id
        )
      where sr.batch_id = v_batch.id
    ),
    updated_rows as (
      update public.salary_records sr
      set
        crm = tr.new_crm,
        finger_print = tr.new_finger_print,
        unpaid_vacations = tr.new_unpaid_vacations,
        total_deductions = coalesce(sr.total_deductions, 0)
          - (tr.old_crm + tr.old_finger_print + tr.old_unpaid_vacations)
          + (tr.new_crm + tr.new_finger_print + tr.new_unpaid_vacations),
        second_part = greatest(
          0,
          coalesce(sr.second_part, 0)
            + (tr.old_crm + tr.old_finger_print + tr.old_unpaid_vacations)
            - (tr.new_crm + tr.new_finger_print + tr.new_unpaid_vacations)
        ),
        month_salary = greatest(
          0,
          coalesce(sr.month_salary, coalesce(sr.first_part, 0) + coalesce(sr.second_part, 0))
            + (tr.old_crm + tr.old_finger_print + tr.old_unpaid_vacations)
            - (tr.new_crm + tr.new_finger_print + tr.new_unpaid_vacations)
        )
      from target_rows tr
      where sr.id = tr.id
        and (
          coalesce(sr.crm, 0) is distinct from tr.new_crm
          or coalesce(sr.finger_print, 0) is distinct from tr.new_finger_print
          or coalesce(sr.unpaid_vacations, 0) is distinct from tr.new_unpaid_vacations
        )
      returning sr.id
    ),
    matched as (
      select
        sr.hr_id,
        tr.new_total_amount as imported_total
      from target_rows tr
      join public.salary_records sr on sr.id = tr.id
      where tr.new_total_amount > 0
    )
    select
      count(*)::integer,
      coalesce(sum(imported_total), 0)::numeric(14, 2),
      coalesce(jsonb_agg(to_jsonb(matched) order by hr_id), '[]'::jsonb)
    into
      v_imported_employees,
      v_imported_total,
      v_matched_employees
    from matched;

    update public.deduction_decisions dd
    set payroll_handoff_status = 'Imported to Payroll'
    where dd.id in (
      select decision_id
      from public.deduction_monthly_summary_lines
      where summary_id = p_summary_id
    );

    if p_import_job_id is not null then
      update public.deduction_payroll_import_jobs
      set
        status = 'completed',
        imported_employees = v_imported_employees,
        imported_total = v_imported_total,
        matched_employees = v_matched_employees,
        unmatched_employees = v_unmatched_employees,
        completed_at = now(),
        error_message = null
      where import_job_id = p_import_job_id;
    end if;
  exception when others then
    if p_import_job_id is not null then
      update public.deduction_payroll_import_jobs
      set
        status = 'failed',
        error_message = sqlerrm,
        completed_at = now()
      where import_job_id = p_import_job_id;
    end if;
    raise;
  end;

  return jsonb_build_object(
    'import_job_id', p_import_job_id,
    'idempotent_replay', false,
    'imported_employees', v_imported_employees,
    'imported_total', v_imported_total,
    'matched_employees', v_matched_employees,
    'unmatched_employees', v_unmatched_employees,
    'target_batch_id', v_batch.id,
    'target_batch_month', v_batch.month,
    'target_batch_year', v_batch.year
  );
end;
$$;

revoke all on function public.phx_import_deductions_governance_to_payroll(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.phx_import_deductions_governance_to_payroll(uuid, uuid, text)
  to service_role;
