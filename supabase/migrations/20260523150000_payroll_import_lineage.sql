-- payroll_import_jobs: per-import audit lineage + idempotency fence
-- Each call to phx_import_approved_expenses_to_payroll that supplies a
-- p_import_job_id is tracked here. A completed row blocks a replay.

create table if not exists public.payroll_import_jobs (
  id                 uuid        primary key default gen_random_uuid(),
  import_job_id      uuid        not null unique,
  batch_id           uuid        references public.salary_batches(id),
  source_file_name   text        not null default '',
  actor_login_id     text        not null default 'system',
  imported_employees integer,
  imported_total     numeric(20,2),
  status             text        not null default 'pending'
                                 check (status in ('pending','completed','failed')),
  error_message      text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index if not exists payroll_import_jobs_batch_id_idx
  on public.payroll_import_jobs (batch_id);

create index if not exists payroll_import_jobs_created_at_idx
  on public.payroll_import_jobs (created_at desc);

-- No public policies — only service_role can read/write this table
alter table public.payroll_import_jobs enable row level security;

revoke all on table public.payroll_import_jobs from public, anon, authenticated;
grant all on table public.payroll_import_jobs to service_role;

-- ---------------------------------------------------------------------------
-- Replace the RPC with a version that accepts an idempotency key, a source
-- file name, and an actor login ID.  The existing 2-argument signature is
-- dropped first because PostgreSQL treats different argument lists as
-- different overloads rather than replacing in place.
-- ---------------------------------------------------------------------------

drop function if exists public.phx_import_approved_expenses_to_payroll(integer, integer);

create or replace function public.phx_import_approved_expenses_to_payroll(
  p_month          integer,
  p_year           integer,
  p_import_job_id  uuid    default null,
  p_source_file    text    default '',
  p_actor_login_id text    default 'system'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch            public.salary_batches%rowtype;
  v_imported_employees integer  := 0;
  v_imported_total     numeric  := 0;
  v_matched_employees  text[]   := '{}'::text[];
  v_existing_job       public.payroll_import_jobs%rowtype;
  v_result             jsonb;
begin
  -- ── Idempotency fence ──────────────────────────────────────────────────
  -- If the same import_job_id already completed we return the stored result
  -- without touching salary_records again.
  if p_import_job_id is not null then
    select * into v_existing_job
    from public.payroll_import_jobs
    where import_job_id = p_import_job_id
    for update;

    if found and v_existing_job.status = 'completed' then
      return jsonb_build_object(
        'import_job_id',       p_import_job_id,
        'idempotent_replay',   true,
        'imported_employees',  v_existing_job.imported_employees,
        'imported_total',      v_existing_job.imported_total,
        'matched_employees',   '[]'::jsonb,
        'target_batch_id',     v_existing_job.batch_id,
        'target_batch_month',  p_month,
        'target_batch_year',   p_year
      );
    end if;
  end if;

  -- ── Lock target batch ──────────────────────────────────────────────────
  select *
  into v_batch
  from public.salary_batches
  where month = p_month
    and year  = p_year
  order by created_at desc, id desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'import_job_id',      p_import_job_id,
      'imported_employees', 0,
      'imported_total',     0,
      'matched_employees',  '[]'::jsonb,
      'target_batch_id',    null,
      'target_batch_month', null,
      'target_batch_year',  null
    );
  end if;

  if v_batch.status not in (
    'part1_paid','adjustments_open','part2_ready','under_review','rejected'
  ) then
    raise exception
      'Payroll batch cannot import expenses before Part 1 is paid or while status is %.',
      v_batch.status
    using errcode = 'P0001';
  end if;

  -- ── Open lineage row ───────────────────────────────────────────────────
  if p_import_job_id is not null then
    insert into public.payroll_import_jobs (
      import_job_id,
      batch_id,
      source_file_name,
      actor_login_id,
      status,
      created_at
    ) values (
      p_import_job_id,
      v_batch.id,
      coalesce(p_source_file, ''),
      coalesce(p_actor_login_id, 'system'),
      'pending',
      now()
    )
    -- A 'pending' row from a concurrent call with the same ID is fine to
    -- overwrite back to 'pending'; a 'failed' row is being retried.
    -- We already returned early for 'completed' above.
    on conflict (import_job_id) do update
      set status     = 'pending',
          created_at = now();
  end if;

  -- ── Import logic (identical to original) ──────────────────────────────
  begin
    with approved_totals as (
      select
        lower(hr_id) as normalized_hr_id,
        min(hr_id)   as hr_id,
        sum(total)::numeric(20,2) as approved_expense
      from public.payroll_expenses
      where hr_approved = true
        and payout_month = p_month
        and payout_year  = p_year
        and hr_id is not null
        and trim(hr_id) <> ''
      group by lower(hr_id)
    ),
    matched_totals as (
      select
        sr.hr_id,
        at.approved_expense
      from public.salary_records sr
      join approved_totals at
        on lower(sr.hr_id) = at.normalized_hr_id
      where sr.batch_id = v_batch.id
    ),
    updated_rows as (
      update public.salary_records sr
      set expenses         = coalesce(at.approved_expense, 0),
          total_additions  = coalesce(sr.total_additions, 0)
                           - coalesce(sr.expenses, 0)
                           + coalesce(at.approved_expense, 0),
          second_part      = coalesce(sr.second_part, 0)
                           - coalesce(sr.expenses, 0)
                           + coalesce(at.approved_expense, 0)
      from (
        select
          sr2.id,
          at2.approved_expense
        from public.salary_records sr2
        left join approved_totals at2
          on lower(sr2.hr_id) = at2.normalized_hr_id
        where sr2.batch_id = v_batch.id
      ) at
      where sr.id = at.id
        and (
          coalesce(sr.expenses, 0) is distinct from coalesce(at.approved_expense, 0)
          or coalesce(sr.second_part, 0) is distinct from
             coalesce(sr.second_part, 0)
             - coalesce(sr.expenses, 0)
             + coalesce(at.approved_expense, 0)
        )
      returning sr.id
    )
    select
      count(*)::integer,
      coalesce(sum(approved_expense), 0)::numeric,
      coalesce(array_agg(hr_id order by hr_id), '{}'::text[])
    into
      v_imported_employees,
      v_imported_total,
      v_matched_employees
    from matched_totals;

    -- ── Mark lineage completed ─────────────────────────────────────────
    if p_import_job_id is not null then
      update public.payroll_import_jobs
      set status             = 'completed',
          imported_employees = v_imported_employees,
          imported_total     = v_imported_total,
          completed_at       = now()
      where import_job_id = p_import_job_id;
    end if;

  exception when others then
    -- ── Mark lineage failed ────────────────────────────────────────────
    if p_import_job_id is not null then
      update public.payroll_import_jobs
      set status        = 'failed',
          error_message = sqlerrm,
          completed_at  = now()
      where import_job_id = p_import_job_id;
    end if;
    raise;
  end;

  v_result := jsonb_build_object(
    'import_job_id',      p_import_job_id,
    'imported_employees', v_imported_employees,
    'imported_total',     v_imported_total,
    'matched_employees',  to_jsonb(v_matched_employees),
    'target_batch_id',    v_batch.id,
    'target_batch_month', v_batch.month,
    'target_batch_year',  v_batch.year
  );

  return v_result;
end;
$$;

revoke all on function public.phx_import_approved_expenses_to_payroll(integer, integer, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.phx_import_approved_expenses_to_payroll(integer, integer, uuid, text, text)
  to service_role;
