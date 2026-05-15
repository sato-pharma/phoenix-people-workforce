create table if not exists public.leave_title_weekend_rules (
  title_key text primary key,
  title text not null,
  weekend_days integer[] not null default array[5],
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_title_weekend_rules_title_not_blank check (length(trim(title)) > 0),
  constraint leave_title_weekend_rules_weekend_days_check check (
    weekend_days <@ array[0, 1, 2, 3, 4, 5, 6]
    and cardinality(weekend_days) between 1 and 7
  )
);

comment on table public.leave_title_weekend_rules is
  'Per-title weekend configuration for Leave Management working-day calculations.';

comment on column public.leave_title_weekend_rules.weekend_days is
  'JavaScript weekday numbers: 5 = Friday, 6 = Saturday. Supported UI choices are {5} and {5,6}.';

alter table public.leave_title_weekend_rules enable row level security;

drop policy if exists leave_title_weekend_rules_service_role
on public.leave_title_weekend_rules;

create policy leave_title_weekend_rules_service_role
on public.leave_title_weekend_rules
for all
to service_role
using (true)
with check (true);

grant select, insert, update, delete on table public.leave_title_weekend_rules to service_role;
