-- Phoenix Workforce contract renewal production stabilization.
-- Idempotent and data-preserving: reconciles old/new employee_contracts shapes,
-- adds transition-safe RPCs, and avoids deleting historical contract data.

create extension if not exists pgcrypto;
alter table public.employees
  add column if not exists contract_renewal_date date null;
create table if not exists public.employee_contracts (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text null references public.employees(hr_id) on update cascade on delete cascade,
  hr_id text null,
  contract_type text null default 'fixed-term',
  contract_signed_date date null,
  contract_start_date date null,
  contract_end_date date null,
  contract_renewal_date date null,
  document_url text null,
  document_name text null,
  signed_document_url text null,
  signed_document_name text null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text null
);
alter table public.employee_contracts add column if not exists employee_hr_id text null;
alter table public.employee_contracts add column if not exists hr_id text null;
alter table public.employee_contracts add column if not exists contract_type text null default 'fixed-term';
alter table public.employee_contracts add column if not exists contract_signed_date date null;
alter table public.employee_contracts add column if not exists contract_start_date date null;
alter table public.employee_contracts add column if not exists contract_end_date date null;
alter table public.employee_contracts add column if not exists contract_renewal_date date null;
alter table public.employee_contracts add column if not exists document_url text null;
alter table public.employee_contracts add column if not exists document_name text null;
alter table public.employee_contracts add column if not exists signed_document_url text null;
alter table public.employee_contracts add column if not exists signed_document_name text null;
alter table public.employee_contracts add column if not exists status text not null default 'active';
alter table public.employee_contracts add column if not exists created_at timestamptz not null default now();
alter table public.employee_contracts add column if not exists updated_at timestamptz not null default now();
alter table public.employee_contracts add column if not exists created_by text null;
alter table public.employee_contracts alter column contract_type set default 'fixed-term';
alter table public.employee_contracts alter column contract_renewal_date drop not null;
alter table public.employee_contracts alter column employee_hr_id drop not null;
alter table public.employee_contracts alter column hr_id drop not null;
update public.employee_contracts
set employee_hr_id = hr_id
where employee_hr_id is null
  and hr_id is not null;
update public.employee_contracts
set hr_id = employee_hr_id
where hr_id is null
  and employee_hr_id is not null;
update public.employee_contracts
set contract_type = 'fixed-term'
where contract_type is null;
alter table public.employee_contracts
  drop constraint if exists employee_contracts_status_check,
  drop constraint if exists employee_contracts_date_range_check;
alter table public.employee_contracts
  add constraint employee_contracts_status_check
    check (status in ('draft', 'active', 'expired', 'renewed', 'terminated', 'not_renewed', 'cancelled')),
  add constraint employee_contracts_date_range_check
    check (contract_start_date is null or contract_end_date is null or contract_end_date >= contract_start_date);
create index if not exists employee_contracts_employee_hr_id_idx
  on public.employee_contracts (employee_hr_id);
create index if not exists employee_contracts_hr_id_idx
  on public.employee_contracts (hr_id);
create index if not exists employee_contracts_status_renewal_idx
  on public.employee_contracts (status, contract_renewal_date);
create table if not exists public.contract_renewal_requests (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  current_contract_id text null,
  employee_name text not null default '',
  job_title text null,
  line_name text null,
  area_name text null,
  current_renewal_date date null,
  requested_renewal_date date not null,
  proposed_start_date date null,
  proposed_end_date date null,
  new_contract_document_url text null,
  new_contract_document_name text null,
  signed_contract_url text null,
  signed_contract_name text null,
  signed_at timestamptz null,
  workflow_notes text null,
  status text not null default 'requested',
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  manager_reviewed_at timestamptz null,
  manager_reviewed_by text null,
  hr_reviewed_at timestamptz null,
  hr_reviewed_by text null,
  decision_at timestamptz null,
  decision_by text null,
  decision_reason text null,
  completed_contract_id text null
);
alter table public.contract_renewal_requests
  drop constraint if exists contract_renewal_requests_status_check,
  drop constraint if exists contract_renewal_requests_date_range_check;
alter table public.contract_renewal_requests
  add constraint contract_renewal_requests_status_check
    check (status in ('requested', 'manager_review', 'hr_review', 'renewed', 'not_renewed', 'cancelled')),
  add constraint contract_renewal_requests_date_range_check
    check (proposed_start_date is null or proposed_end_date is null or proposed_end_date >= proposed_start_date);
create index if not exists contract_renewal_requests_employee_hr_id_idx
  on public.contract_renewal_requests (employee_hr_id);
create index if not exists contract_renewal_requests_status_idx
  on public.contract_renewal_requests (status);
create index if not exists contract_renewal_requests_requested_date_idx
  on public.contract_renewal_requests (requested_renewal_date);
create table if not exists public.contract_renewal_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid null references public.contract_renewal_requests(id) on update cascade on delete set null,
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  action text not null,
  old_renewal_date date null,
  new_renewal_date date null,
  actor text null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists contract_renewal_history_employee_hr_id_idx
  on public.contract_renewal_history (employee_hr_id, created_at desc);
do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'contract_renewal_requests_one_active_idx'
  ) and not exists (
    select 1
    from public.contract_renewal_requests
    where status in ('requested', 'manager_review', 'hr_review')
    group by upper(employee_hr_id)
    having count(*) > 1
  ) then
    create unique index contract_renewal_requests_one_active_idx
      on public.contract_renewal_requests (upper(employee_hr_id))
      where status in ('requested', 'manager_review', 'hr_review');
  end if;
end $$;
do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'employee_contracts_one_active_idx'
  ) and not exists (
    select 1
    from public.employee_contracts
    where status = 'active'
      and coalesce(employee_hr_id, hr_id) is not null
    group by upper(coalesce(employee_hr_id, hr_id))
    having count(*) > 1
  ) then
    create unique index employee_contracts_one_active_idx
      on public.employee_contracts (upper(coalesce(employee_hr_id, hr_id)))
      where status = 'active';
  end if;
end $$;
create or replace function public.phx_contract_note(
  p_existing text,
  p_actor text,
  p_action text,
  p_note text
)
returns text
language sql
stable
as $$
  select concat_ws(
    E'\n',
    nullif(p_existing, ''),
    '[' || now()::text || '] ' || coalesce(nullif(p_actor, ''), 'system') || ': ' || p_action ||
      case when nullif(p_note, '') is null then '' else ' - ' || p_note end
  );
$$;
create or replace function public.phx_create_contract_renewal_request(
  p_employee_hr_id text,
  p_current_contract_id text,
  p_employee_name text,
  p_job_title text,
  p_line_name text,
  p_area_name text,
  p_current_renewal_date date,
  p_requested_renewal_date date,
  p_proposed_start_date date,
  p_proposed_end_date date,
  p_new_contract_document_url text,
  p_new_contract_document_name text,
  p_actor text,
  p_note text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_active_contract_count integer := 0;
  v_employee record;
  v_request contract_renewal_requests%rowtype;
  v_start date := coalesce(p_proposed_start_date, p_requested_renewal_date);
  v_end date;
begin
  v_end := coalesce(p_proposed_end_date, (v_start + interval '1 year')::date);

  select hr_id, hire_date, employment_status
  into v_employee
  from public.employees
  where upper(hr_id) = upper(trim(p_employee_hr_id))
  for update;

  if not found then
    raise exception 'Employee was not found in the directory.';
  end if;

  if lower(coalesce(v_employee.employment_status, 'active')) not in ('active', 'on_leave') then
    raise exception 'Contract renewals can only be created for active employees.';
  end if;

  if p_requested_renewal_date is null then
    raise exception 'Requested renewal date is required.';
  end if;

  if v_employee.hire_date is not null and p_requested_renewal_date < v_employee.hire_date then
    raise exception 'Renewal date cannot be before the employee hire date.';
  end if;

  if v_employee.hire_date is not null and v_start < v_employee.hire_date then
    raise exception 'Proposed start date cannot be before the employee hire date.';
  end if;

  if p_current_renewal_date is not null and v_start < p_current_renewal_date then
    raise exception 'Proposed start date cannot be before the current renewal date.';
  end if;

  if v_end < v_start then
    raise exception 'Proposed end date cannot be before the proposed start date.';
  end if;

  select count(*)
  into v_active_contract_count
  from public.employee_contracts
  where upper(coalesce(employee_hr_id, hr_id, '')) = upper(v_employee.hr_id)
    and lower(coalesce(status, 'active')) = 'active';

  if v_active_contract_count > 1 then
    raise exception 'Employee has multiple active contracts. Resolve duplicate active contracts before renewal.';
  end if;

  if exists (
    select 1
    from public.contract_renewal_requests
    where upper(employee_hr_id) = upper(v_employee.hr_id)
      and status in ('requested', 'manager_review', 'hr_review')
  ) then
    raise exception 'An active renewal request already exists for this employee.';
  end if;

  insert into public.contract_renewal_requests (
    area_name,
    created_by,
    current_contract_id,
    current_renewal_date,
    employee_hr_id,
    employee_name,
    job_title,
    line_name,
    new_contract_document_name,
    new_contract_document_url,
    proposed_end_date,
    proposed_start_date,
    requested_renewal_date,
    status,
    workflow_notes
  )
  values (
    p_area_name,
    p_actor,
    p_current_contract_id,
    p_current_renewal_date,
    v_employee.hr_id,
    coalesce(p_employee_name, ''),
    p_job_title,
    p_line_name,
    nullif(trim(coalesce(p_new_contract_document_name, '')), ''),
    nullif(trim(coalesce(p_new_contract_document_url, '')), ''),
    v_end,
    v_start,
    p_requested_renewal_date,
    'requested',
    public.phx_contract_note(null, p_actor, 'created renewal request', p_note)
  )
  returning * into v_request;

  insert into public.contract_renewal_history (
    action,
    actor,
    details,
    employee_hr_id,
    new_renewal_date,
    old_renewal_date,
    request_id
  )
  values (
    'requested',
    p_actor,
    jsonb_build_object('note', p_note),
    v_request.employee_hr_id,
    v_request.requested_renewal_date,
    v_request.current_renewal_date,
    v_request.id
  );

  return to_jsonb(v_request);
end;
$$;
create or replace function public.phx_apply_contract_renewal_workflow(
  p_request_id uuid,
  p_action text,
  p_actor text,
  p_note text default null,
  p_decision_reason text default null,
  p_new_contract_document_url text default null,
  p_new_contract_document_name text default null,
  p_signed_contract_url text default null,
  p_signed_contract_name text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_request contract_renewal_requests%rowtype;
  v_employee record;
  v_updated contract_renewal_requests%rowtype;
  v_now timestamptz := now();
  v_start date;
  v_end date;
  v_completed_contract_id text := null;
begin
  if p_action not in ('manager_review', 'hr_review', 'renew', 'not_renew', 'upload_signed', 'cancel') then
    raise exception 'Unsupported contract renewal action.';
  end if;

  select *
  into v_request
  from public.contract_renewal_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Contract renewal request not found.';
  end if;

  select hr_id, hire_date, employment_status
  into v_employee
  from public.employees
  where upper(hr_id) = upper(v_request.employee_hr_id)
  for update;

  if not found then
    raise exception 'Employee was not found in the directory.';
  end if;

  if lower(coalesce(v_employee.employment_status, 'active')) not in ('active', 'on_leave') then
    raise exception 'Contract renewals can only be updated for active employees.';
  end if;

  if p_action in ('renew', 'not_renew', 'cancel') and v_request.status in ('renewed', 'not_renewed', 'cancelled') then
    raise exception 'Finalized renewal requests cannot be decided again.';
  end if;

  if p_action = 'manager_review' then
    if v_request.status not in ('requested', 'manager_review') then
      raise exception 'Only requested renewals can be marked as manager reviewed.';
    end if;

    update public.contract_renewal_requests
    set status = 'manager_review',
        manager_reviewed_at = v_now,
        manager_reviewed_by = p_actor,
        updated_at = v_now,
        workflow_notes = public.phx_contract_note(workflow_notes, p_actor, p_action, p_note),
        new_contract_document_url = coalesce(nullif(trim(coalesce(p_new_contract_document_url, '')), ''), new_contract_document_url),
        new_contract_document_name = coalesce(nullif(trim(coalesce(p_new_contract_document_name, '')), ''), new_contract_document_name)
    where id = v_request.id
    returning * into v_updated;
  elsif p_action = 'hr_review' then
    if v_request.status not in ('requested', 'manager_review', 'hr_review') then
      raise exception 'Only active renewals can be marked as HR reviewed.';
    end if;

    update public.contract_renewal_requests
    set status = 'hr_review',
        hr_reviewed_at = v_now,
        hr_reviewed_by = p_actor,
        updated_at = v_now,
        workflow_notes = public.phx_contract_note(workflow_notes, p_actor, p_action, p_note),
        new_contract_document_url = coalesce(nullif(trim(coalesce(p_new_contract_document_url, '')), ''), new_contract_document_url),
        new_contract_document_name = coalesce(nullif(trim(coalesce(p_new_contract_document_name, '')), ''), new_contract_document_name)
    where id = v_request.id
    returning * into v_updated;
  elsif p_action = 'upload_signed' then
    if v_request.status not in ('hr_review', 'renewed') then
      raise exception 'Signed contracts can be uploaded after HR review or renewal.';
    end if;

    if nullif(trim(coalesce(p_signed_contract_url, '')), '') is null then
      raise exception 'Signed contract URL is required.';
    end if;

    update public.contract_renewal_requests
    set signed_contract_url = nullif(trim(coalesce(p_signed_contract_url, '')), ''),
        signed_contract_name = nullif(trim(coalesce(p_signed_contract_name, '')), ''),
        signed_at = v_now,
        updated_at = v_now,
        workflow_notes = public.phx_contract_note(workflow_notes, p_actor, p_action, p_note)
    where id = v_request.id
    returning * into v_updated;

    if v_updated.completed_contract_id is not null then
      update public.employee_contracts
      set signed_document_url = v_updated.signed_contract_url,
          signed_document_name = v_updated.signed_contract_name,
          updated_at = v_now
      where id::text = v_updated.completed_contract_id;
    end if;
  elsif p_action = 'renew' then
    if v_request.status not in ('requested', 'manager_review', 'hr_review') then
      raise exception 'Only active renewal requests can be renewed.';
    end if;

    if exists (
      select 1
      from public.contract_renewal_requests
      where upper(employee_hr_id) = upper(v_request.employee_hr_id)
        and id <> v_request.id
        and status in ('requested', 'manager_review', 'hr_review')
    ) then
      raise exception 'Another active renewal request exists for this employee.';
    end if;

    if exists (
      select 1
      from public.employee_contracts
      where upper(coalesce(employee_hr_id, hr_id)) = upper(v_request.employee_hr_id)
        and status = 'active'
        and (v_request.current_contract_id is null or id::text <> v_request.current_contract_id)
    ) then
      raise exception 'Another active contract exists for this employee.';
    end if;

    v_start := coalesce(v_request.proposed_start_date, v_request.requested_renewal_date);
    v_end := coalesce(v_request.proposed_end_date, (v_start + interval '1 year')::date);

    if v_employee.hire_date is not null and v_request.requested_renewal_date < v_employee.hire_date then
      raise exception 'Renewal date cannot be before the employee hire date.';
    end if;

    if v_request.current_renewal_date is not null and v_start < v_request.current_renewal_date then
      raise exception 'Proposed start date cannot be before the current renewal date.';
    end if;

    if v_end < v_start then
      raise exception 'Proposed end date cannot be before the proposed start date.';
    end if;

    if v_request.current_contract_id is not null then
      update public.employee_contracts
      set status = case when status = 'active' then 'expired' else status end,
          contract_end_date = coalesce(contract_end_date, v_start - 1),
          updated_at = v_now
      where id::text = v_request.current_contract_id;
    end if;

    insert into public.employee_contracts (
      employee_hr_id,
      hr_id,
      contract_type,
      contract_signed_date,
      contract_start_date,
      contract_end_date,
      contract_renewal_date,
      document_name,
      document_url,
      signed_document_name,
      signed_document_url,
      status,
      created_by,
      updated_at
    )
    values (
      v_request.employee_hr_id,
      v_request.employee_hr_id,
      'fixed-term',
      current_date,
      v_start,
      v_end,
      v_end,
      v_request.new_contract_document_name,
      v_request.new_contract_document_url,
      v_request.signed_contract_name,
      v_request.signed_contract_url,
      'active',
      p_actor,
      v_now
    )
    returning id::text into v_completed_contract_id;

    update public.employees
    set contract_renewal_date = v_end,
        updated_at = v_now
    where upper(hr_id) = upper(v_request.employee_hr_id);

    update public.contract_renewal_requests
    set status = 'renewed',
        decision_at = v_now,
        decision_by = p_actor,
        decision_reason = nullif(trim(coalesce(p_decision_reason, '')), ''),
        completed_contract_id = v_completed_contract_id,
        updated_at = v_now,
        workflow_notes = public.phx_contract_note(workflow_notes, p_actor, p_action, p_note)
    where id = v_request.id
    returning * into v_updated;
  elsif p_action = 'not_renew' then
    if v_request.status not in ('requested', 'manager_review', 'hr_review') then
      raise exception 'Only active renewal requests can be marked not renewed.';
    end if;

    if v_request.current_contract_id is not null then
      update public.employee_contracts
      set status = 'not_renewed',
          updated_at = v_now
      where id::text = v_request.current_contract_id;
    end if;

    update public.contract_renewal_requests
    set status = 'not_renewed',
        decision_at = v_now,
        decision_by = p_actor,
        decision_reason = coalesce(nullif(trim(coalesce(p_decision_reason, '')), ''), 'No reason provided.'),
        updated_at = v_now,
        workflow_notes = public.phx_contract_note(workflow_notes, p_actor, p_action, p_note)
    where id = v_request.id
    returning * into v_updated;
  elsif p_action = 'cancel' then
    if v_request.status in ('renewed', 'not_renewed', 'cancelled') then
      raise exception 'Finalized renewal requests cannot be cancelled.';
    end if;

    update public.contract_renewal_requests
    set status = 'cancelled',
        decision_at = v_now,
        decision_by = p_actor,
        decision_reason = coalesce(nullif(trim(coalesce(p_decision_reason, '')), ''), 'Cancelled.'),
        updated_at = v_now,
        workflow_notes = public.phx_contract_note(workflow_notes, p_actor, p_action, p_note)
    where id = v_request.id
    returning * into v_updated;
  end if;

  insert into public.contract_renewal_history (
    action,
    actor,
    details,
    employee_hr_id,
    new_renewal_date,
    old_renewal_date,
    request_id
  )
  values (
    p_action,
    p_actor,
    jsonb_build_object('note', p_note, 'decisionReason', p_decision_reason),
    v_updated.employee_hr_id,
    case when p_action = 'renew' then v_end else v_updated.requested_renewal_date end,
    v_request.current_renewal_date,
    v_updated.id
  );

  return to_jsonb(v_updated);
end;
$$;
alter table public.employee_contracts enable row level security;
alter table public.contract_renewal_requests enable row level security;
alter table public.contract_renewal_history enable row level security;
revoke all on public.employee_contracts from anon, authenticated;
revoke all on public.contract_renewal_requests from anon, authenticated;
revoke all on public.contract_renewal_history from anon, authenticated;
grant all on public.employee_contracts to service_role;
grant all on public.contract_renewal_requests to service_role;
grant all on public.contract_renewal_history to service_role;
revoke execute on function public.phx_contract_note(text,text,text,text) from public, anon, authenticated;
revoke execute on function public.phx_create_contract_renewal_request(text,text,text,text,text,text,date,date,date,date,text,text,text,text) from public, anon, authenticated;
revoke execute on function public.phx_apply_contract_renewal_workflow(uuid,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.phx_contract_note(text,text,text,text) to service_role;
grant execute on function public.phx_create_contract_renewal_request(text,text,text,text,text,text,date,date,date,date,text,text,text,text) to service_role;
grant execute on function public.phx_apply_contract_renewal_workflow(uuid,text,text,text,text,text,text,text,text) to service_role;
drop policy if exists phx_employee_contracts_service_role on public.employee_contracts;
create policy phx_employee_contracts_service_role
  on public.employee_contracts
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists phx_contract_renewal_requests_service_role on public.contract_renewal_requests;
create policy phx_contract_renewal_requests_service_role
  on public.contract_renewal_requests
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists phx_contract_renewal_history_service_role on public.contract_renewal_history;
create policy phx_contract_renewal_history_service_role
  on public.contract_renewal_history
  for all
  to service_role
  using (true)
  with check (true);
notify pgrst, 'reload schema';
