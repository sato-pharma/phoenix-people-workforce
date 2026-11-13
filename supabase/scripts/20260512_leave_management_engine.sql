-- Phoenix Workforce Leave Management Engine.
-- Rebuilds the old vacation/leave domain into a policy-based, ledger-backed model.

begin;

create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

drop table if exists public.vacation_attachments cascade;
drop table if exists public.vacation_approvals cascade;
drop table if exists public.vacation_balances cascade;
drop table if exists public.vacation_requests cascade;
drop table if exists public.vacation_settings cascade;
drop table if exists public.vacation_types cascade;

drop table if exists public.leave_approvals cascade;
drop table if exists public.leave_transactions cascade;
drop table if exists public.leave_requests cascade;
drop table if exists public.employee_leave_balances cascade;
drop table if exists public.public_holidays cascade;
drop table if exists public.leave_policies cascade;
drop table if exists public.leave_types cascade;

create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_paid boolean not null default true,
  affects_payroll boolean not null default false,
  requires_attachment boolean not null default false,
  requires_manager_approval boolean not null default true,
  requires_hr_approval boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.leave_policies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text not null default 'EG',
  annual_days_first_year numeric(8, 2) not null default 15,
  annual_days_after_first_year numeric(8, 2) not null default 21,
  accrual_method text not null default 'monthly',
  accrual_frequency text not null default 'monthly',
  allow_negative_balance boolean not null default false,
  carry_forward_enabled boolean not null default false,
  carry_forward_limit numeric(8, 2) not null default 0,
  carry_forward_expiry_months integer not null default 0,
  weekend_days integer[] not null default array[5, 6],
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_policies_accrual_method_check
    check (accrual_method = 'monthly'),
  constraint leave_policies_accrual_frequency_check
    check (accrual_frequency = 'monthly'),
  constraint leave_policies_weekend_days_check
    check (weekend_days <@ array[0, 1, 2, 3, 4, 5, 6])
);

create unique index leave_policies_default_active_uidx
  on public.leave_policies (country)
  where is_default = true and is_active = true;

create table public.employee_leave_balances (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on update cascade on delete restrict,
  policy_id uuid not null references public.leave_policies(id) on update cascade on delete restrict,
  year integer not null,
  opening_balance numeric(8, 2) not null default 0,
  accrued numeric(8, 2) not null default 0,
  consumed numeric(8, 2) not null default 0,
  pending numeric(8, 2) not null default 0,
  adjusted numeric(8, 2) not null default 0,
  carry_forward numeric(8, 2) not null default 0,
  available_balance numeric(8, 2) not null default 0,
  last_accrual_date date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_leave_balances_year_check check (year between 2000 and 2100),
  constraint employee_leave_balances_unique
    unique (employee_hr_id, leave_type_id, policy_id, year)
);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on update cascade on delete restrict,
  policy_id uuid not null references public.leave_policies(id) on update cascade on delete restrict,
  start_date date not null,
  end_date date not null,
  total_calendar_days numeric(8, 2) not null default 0,
  total_working_days numeric(8, 2) not null default 0,
  reason text null,
  attachment_url text null,
  status text not null default 'pending_manager',
  manager_status text not null default 'pending',
  hr_status text not null default 'pending',
  payroll_status text not null default 'not_required',
  manager_comment text null,
  hr_comment text null,
  requested_at timestamptz not null default now(),
  manager_decision_at timestamptz null,
  hr_decision_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_requests_date_check check (end_date >= start_date),
  constraint leave_requests_status_check
    check (status in (
      'draft',
      'pending_manager',
      'manager_approved',
      'manager_rejected',
      'pending_hr',
      'hr_approved',
      'hr_rejected',
      'cancelled'
    )),
  constraint leave_requests_manager_status_check
    check (manager_status in ('pending', 'approved', 'rejected', 'not_required')),
  constraint leave_requests_hr_status_check
    check (hr_status in ('pending', 'approved', 'rejected', 'not_required')),
  constraint leave_requests_payroll_status_check
    check (payroll_status in ('not_required', 'pending', 'processed', 'blocked'))
);

create table public.leave_transactions (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on update cascade on delete restrict,
  policy_id uuid not null references public.leave_policies(id) on update cascade on delete restrict,
  request_id uuid null references public.leave_requests(id) on update cascade on delete set null,
  transaction_type text not null,
  amount numeric(8, 2) not null,
  balance_before numeric(8, 2) not null default 0,
  balance_after numeric(8, 2) not null default 0,
  notes text null,
  created_by text null,
  created_at timestamptz not null default now(),
  constraint leave_transactions_type_check
    check (transaction_type in (
      'opening_balance',
      'accrual',
      'carry_forward',
      'adjustment',
      'pending',
      'pending_reversal',
      'consumed',
      'consumed_reversal'
    ))
);

create table public.leave_approvals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.leave_requests(id) on update cascade on delete cascade,
  approver_hr_id text not null,
  approver_role text not null,
  approval_step text not null,
  status text not null,
  comment text null,
  action_date timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint leave_approvals_step_check check (approval_step in ('manager', 'hr', 'system')),
  constraint leave_approvals_status_check check (status in ('approved', 'rejected', 'cancelled', 'adjusted'))
);

create table public.public_holidays (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  date date not null,
  year integer not null,
  country text not null default 'EG',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint public_holidays_unique unique (country, date)
);

create index leave_requests_employee_idx on public.leave_requests (employee_hr_id, requested_at desc);
create index leave_requests_status_idx on public.leave_requests (status, requested_at desc);
create index leave_requests_dates_idx on public.leave_requests (start_date, end_date);
create index leave_transactions_balance_idx on public.leave_transactions (employee_hr_id, leave_type_id, policy_id, created_at);
create index leave_transactions_request_idx on public.leave_transactions (request_id);
create unique index leave_transactions_monthly_accrual_uidx
  on public.leave_transactions (employee_hr_id, leave_type_id, policy_id, transaction_type, notes)
  where transaction_type = 'accrual' and notes like 'monthly-accrual:%';
create unique index leave_transactions_request_type_uidx
  on public.leave_transactions (request_id, transaction_type)
  where request_id is not null
    and transaction_type in ('pending', 'pending_reversal', 'consumed', 'consumed_reversal');
create index leave_approvals_request_idx on public.leave_approvals (request_id, created_at);
create index public_holidays_country_year_idx on public.public_holidays (country, year);

insert into public.leave_types (
  code,
  name,
  is_paid,
  affects_payroll,
  requires_attachment,
  requires_manager_approval,
  requires_hr_approval
)
values
  ('annual_leave', 'Annual Leave', true, false, false, true, true),
  ('sick_leave', 'Sick Leave', true, false, true, true, true),
  ('casual_leave', 'Casual Leave', true, false, false, true, true),
  ('unpaid_leave', 'Unpaid Leave', false, true, false, true, true),
  ('emergency_leave', 'Emergency Leave', true, false, false, true, true),
  ('other', 'Other', true, false, false, true, true);

insert into public.leave_policies (
  name,
  country,
  annual_days_first_year,
  annual_days_after_first_year,
  accrual_method,
  accrual_frequency,
  allow_negative_balance,
  carry_forward_enabled,
  carry_forward_limit,
  carry_forward_expiry_months,
  weekend_days,
  is_default,
  is_active
)
values (
  'Egypt Annual Leave Policy',
  'EG',
  15,
  21,
  'monthly',
  'monthly',
  false,
  false,
  0,
  0,
  array[5, 6],
  true,
  true
);

insert into public.public_holidays (name, date, year, country)
values
  ('Coptic Christmas Day', date '2026-01-07', 2026, 'EG'),
  ('January 25 Revolution and Police Day', date '2026-01-25', 2026, 'EG'),
  ('Eid al-Fitr Holiday', date '2026-03-20', 2026, 'EG'),
  ('Sinai Liberation Day', date '2026-04-25', 2026, 'EG'),
  ('Labor Day', date '2026-05-01', 2026, 'EG'),
  ('Eid al-Adha Holiday', date '2026-05-27', 2026, 'EG'),
  ('June 30 Revolution', date '2026-06-30', 2026, 'EG'),
  ('Revolution Day', date '2026-07-23', 2026, 'EG'),
  ('Armed Forces Day', date '2026-10-06', 2026, 'EG')
on conflict (country, date) do update
set name = excluded.name,
    year = excluded.year,
    is_active = true;

create or replace function private.phx_can_manage_leave()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(private.phx_current_role(), 'Employee') in ('Super Admin', 'HR Specialist')
    or coalesce(private.phx_current_scope(), 'SELF') in ('SUPER_ADMIN', 'HR');
$$;

create or replace function private.phx_can_process_leave_payroll()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(private.phx_current_role(), 'Employee') in ('Super Admin', 'HR Specialist', 'Finance Manager')
    or coalesce(private.phx_current_scope(), 'SELF') in ('SUPER_ADMIN', 'HR', 'FINANCE');
$$;

grant execute on function private.phx_can_manage_leave() to authenticated, service_role;
grant execute on function private.phx_can_process_leave_payroll() to authenticated, service_role;

alter table public.leave_types enable row level security;
alter table public.leave_policies enable row level security;
alter table public.employee_leave_balances enable row level security;
alter table public.leave_requests enable row level security;
alter table public.leave_transactions enable row level security;
alter table public.leave_approvals enable row level security;
alter table public.public_holidays enable row level security;

revoke all on public.leave_types from anon, authenticated;
revoke all on public.leave_policies from anon, authenticated;
revoke all on public.employee_leave_balances from anon, authenticated;
revoke all on public.leave_requests from anon, authenticated;
revoke all on public.leave_transactions from anon, authenticated;
revoke all on public.leave_approvals from anon, authenticated;
revoke all on public.public_holidays from anon, authenticated;

grant select on public.leave_types, public.leave_policies, public.employee_leave_balances, public.leave_requests, public.leave_transactions, public.leave_approvals, public.public_holidays to authenticated;
grant insert on public.leave_requests to authenticated;
grant all on public.leave_types, public.leave_policies, public.employee_leave_balances, public.leave_requests, public.leave_transactions, public.leave_approvals, public.public_holidays to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'leave_types',
    'leave_policies',
    'employee_leave_balances',
    'leave_requests',
    'leave_transactions',
    'leave_approvals',
    'public_holidays'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', 'phx_' || table_name || '_service_role', table_name);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      'phx_' || table_name || '_service_role',
      table_name
    );
  end loop;
end $$;

create policy leave_types_select_active
  on public.leave_types
  for select
  to authenticated
  using (is_active or private.phx_can_manage_leave());

create policy leave_types_manage
  on public.leave_types
  for all
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

create policy leave_policies_select_active
  on public.leave_policies
  for select
  to authenticated
  using (is_active or private.phx_can_manage_leave());

create policy leave_policies_manage
  on public.leave_policies
  for all
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

create policy public_holidays_select_active
  on public.public_holidays
  for select
  to authenticated
  using (is_active or private.phx_can_manage_leave());

create policy public_holidays_manage
  on public.public_holidays
  for all
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

create policy employee_leave_balances_select_access
  on public.employee_leave_balances
  for select
  to authenticated
  using (private.phx_can_manage_leave() or private.phx_can_access_employee(employee_hr_id));

create policy employee_leave_balances_manage
  on public.employee_leave_balances
  for all
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

create policy leave_requests_select_access
  on public.leave_requests
  for select
  to authenticated
  using (
    private.phx_can_manage_leave()
    or private.phx_can_access_employee(employee_hr_id)
    or (
      private.phx_can_process_leave_payroll()
      and payroll_status in ('pending', 'processed')
    )
  );

create policy leave_requests_insert_self
  on public.leave_requests
  for insert
  to authenticated
  with check (
    private.phx_can_manage_leave()
    or (
      lower(employee_hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
      and status in ('draft', 'pending_manager')
      and manager_status in ('pending', 'not_required')
      and hr_status in ('pending', 'not_required')
      and payroll_status in ('not_required', 'pending')
    )
  );

create policy leave_requests_update_access
  on public.leave_requests
  for update
  to authenticated
  using (
    private.phx_can_manage_leave()
    or private.phx_can_access_employee(employee_hr_id)
    or lower(employee_hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
  )
  with check (
    private.phx_can_manage_leave()
    or private.phx_can_access_employee(employee_hr_id)
    or lower(employee_hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

create policy leave_transactions_select_access
  on public.leave_transactions
  for select
  to authenticated
  using (
    private.phx_can_manage_leave()
    or private.phx_can_access_employee(employee_hr_id)
    or (
      private.phx_can_process_leave_payroll()
      and exists (
        select 1
        from public.leave_requests lr
        where lr.id = leave_transactions.request_id
          and lr.payroll_status in ('pending', 'processed')
      )
    )
  );

create policy leave_transactions_manage
  on public.leave_transactions
  for all
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

create policy leave_approvals_select_access
  on public.leave_approvals
  for select
  to authenticated
  using (
    private.phx_can_manage_leave()
    or lower(approver_hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
    or exists (
      select 1
      from public.leave_requests lr
      where lr.id = leave_approvals.request_id
        and private.phx_can_access_employee(lr.employee_hr_id)
    )
  );

create policy leave_approvals_insert_access
  on public.leave_approvals
  for insert
  to authenticated
  with check (
    private.phx_can_manage_leave()
    or lower(approver_hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

do $$
begin
  if to_regclass('public.email_notification_policies') is not null then
    alter table public.email_notification_policies
      add column if not exists recipient_modes text[] not null default array['hr_notifications']::text[],
      add column if not exists target_titles text[] not null default '{}'::text[],
      add column if not exists target_lines text[] not null default '{}'::text[],
      add column if not exists template_subject text null,
      add column if not exists template_title text null,
      add column if not exists template_greeting text null,
      add column if not exists template_body_text text null,
      add column if not exists template_closing_text text null,
      add column if not exists template_preview_text text null,
      add column if not exists include_hr_inbox boolean not null default false;

    alter table public.email_notification_policies
      drop constraint if exists email_notification_policies_type_check;

    alter table public.email_notification_policies
      add constraint email_notification_policies_type_check
        check (notification_type in (
          'probation',
          'contract_renewal',
          'birthday',
          'offer',
          'resignation',
          'leave',
          'password_reset',
          'user_created',
          'general'
        ));

    insert into public.email_notification_policies (
      notification_type,
      label,
      description,
      enabled,
      recipient_mode,
      recipient_modes,
      include_hr_inbox,
      template_subject,
      template_title,
      template_greeting,
      template_body_text,
      template_closing_text,
      template_preview_text
    )
    values (
      'leave',
      'Leave Management',
      'Leave request approvals and results routed through managers and HR.',
      true,
      'manager_chain',
      array['manager_chain', 'hr_notifications'],
      true,
      '{subject}',
      '{title}',
      'Dear Phoenix Team,',
      '{summary}',
      'Please review the leave workflow and complete the required action.',
      'Leave workflow update from Phoenix Workforce.'
    )
    on conflict (notification_type) do update
    set
      label = excluded.label,
      description = excluded.description,
      recipient_modes = excluded.recipient_modes,
      include_hr_inbox = excluded.include_hr_inbox,
      template_subject = coalesce(public.email_notification_policies.template_subject, excluded.template_subject),
      template_title = coalesce(public.email_notification_policies.template_title, excluded.template_title),
      template_greeting = coalesce(public.email_notification_policies.template_greeting, excluded.template_greeting),
      template_body_text = coalesce(public.email_notification_policies.template_body_text, excluded.template_body_text),
      template_closing_text = coalesce(public.email_notification_policies.template_closing_text, excluded.template_closing_text),
      template_preview_text = coalesce(public.email_notification_policies.template_preview_text, excluded.template_preview_text);
  end if;
end $$;

do $$
declare
  has_key_column boolean;
  has_name_column boolean;
begin
  if to_regclass('public.permissions') is null then
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'permissions' and column_name = 'key'
  ) into has_key_column;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'permissions' and column_name = 'name'
  ) into has_name_column;

  create temporary table if not exists leave_permission_seed (
    action text primary key,
    permission_key text not null,
    permission_name text not null
  ) on commit drop;

  truncate table leave_permission_seed;

  insert into leave_permission_seed (action, permission_key, permission_name)
  values
    ('read', 'leave.read', 'Leave read'),
    ('create', 'leave.create', 'Leave create'),
    ('update', 'leave.update', 'Leave update'),
    ('delete', 'leave.delete', 'Leave delete'),
    ('approve', 'leave.approve', 'Leave approve'),
    ('export', 'leave.export', 'Leave export'),
    ('import', 'leave.import', 'Leave import');

  if has_key_column and has_name_column then
    insert into public.permissions (key, name, resource, action)
    select permission_key, permission_name, 'leave', action
    from leave_permission_seed
    on conflict (resource, action) do nothing;
  elsif has_key_column then
    insert into public.permissions (key, resource, action)
    select permission_key, 'leave', action
    from leave_permission_seed
    on conflict (resource, action) do nothing;
  elsif has_name_column then
    insert into public.permissions (name, resource, action)
    select permission_name, 'leave', action
    from leave_permission_seed
    on conflict (resource, action) do nothing;
  else
    insert into public.permissions (resource, action)
    select 'leave', action
    from leave_permission_seed
    on conflict (resource, action) do nothing;
  end if;
end $$;

commit;
