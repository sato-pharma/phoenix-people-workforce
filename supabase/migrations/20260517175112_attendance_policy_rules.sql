create table if not exists public.attendance_policy_groups (
  id bigserial primary key,
  policy_name text not null,
  target_type text not null,
  target_value text null,
  scheduled_start time not null,
  scheduled_end time not null,
  grace_minutes integer not null default 0,
  is_active boolean not null default true,
  effective_from date not null default current_date,
  effective_to date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_policy_groups_target_type_check
    check (target_type in ('default', 'job_title', 'employee_hr_id')),
  constraint attendance_policy_groups_default_target_check
    check (
      (target_type = 'default' and target_value is null)
      or (target_type <> 'default' and nullif(trim(target_value), '') is not null)
    ),
  constraint attendance_policy_groups_grace_minutes_check
    check (grace_minutes >= 0 and grace_minutes <= 240),
  constraint attendance_policy_groups_effective_range_check
    check (effective_to is null or effective_to >= effective_from)
);

create unique index if not exists attendance_policy_groups_target_effective_idx
  on public.attendance_policy_groups (target_type, coalesce(target_value, '__default__'), effective_from);

create index if not exists attendance_policy_groups_active_idx
  on public.attendance_policy_groups (target_type, target_value, is_active)
  where is_active is true;

create table if not exists public.attendance_policy_rules (
  id bigserial primary key,
  policy_id bigint not null references public.attendance_policy_groups(id) on delete cascade,
  event_type text not null,
  from_minutes integer null,
  to_minutes integer null,
  recommended_action text not null,
  deduction_days numeric(8,2) null,
  deduction_value numeric(12,2) null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_policy_rules_event_type_check
    check (event_type in ('late', 'early_leave', 'single_punch', 'absence')),
  constraint attendance_policy_rules_minutes_check
    check (
      (from_minutes is null or from_minutes >= 0)
      and (to_minutes is null or to_minutes >= 0)
      and (from_minutes is null or to_minutes is null or to_minutes >= from_minutes)
    ),
  constraint attendance_policy_rules_deduction_days_check
    check (deduction_days is null or deduction_days >= 0),
  constraint attendance_policy_rules_deduction_value_check
    check (deduction_value is null or deduction_value >= 0)
);

create index if not exists attendance_policy_rules_policy_idx
  on public.attendance_policy_rules (policy_id, sort_order, id);

create index if not exists attendance_policy_rules_active_idx
  on public.attendance_policy_rules (policy_id, event_type, is_active)
  where is_active is true;

alter table public.attendance_policy_groups enable row level security;
alter table public.attendance_policy_rules enable row level security;

revoke all on table public.attendance_policy_groups from anon, authenticated;
revoke all on table public.attendance_policy_rules from anon, authenticated;
grant select, insert, update, delete on table public.attendance_policy_groups to service_role;
grant select, insert, update, delete on table public.attendance_policy_rules to service_role;
grant usage, select on sequence public.attendance_policy_groups_id_seq to service_role;
grant usage, select on sequence public.attendance_policy_rules_id_seq to service_role;

drop policy if exists attendance_policy_groups_service_role_all
  on public.attendance_policy_groups;
create policy attendance_policy_groups_service_role_all
  on public.attendance_policy_groups
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists attendance_policy_rules_service_role_all
  on public.attendance_policy_rules;
create policy attendance_policy_rules_service_role_all
  on public.attendance_policy_rules
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.attendance_policy_groups is
  'Attendance policy groups targeted by default, job title, or employee HR_ID. Used for report calculations only until HR approves payroll integration.';

comment on table public.attendance_policy_rules is
  'Attendance policy rule brackets for late arrival, early leave, single punch, and absence actions. Deduction fields are report recommendations only.';
