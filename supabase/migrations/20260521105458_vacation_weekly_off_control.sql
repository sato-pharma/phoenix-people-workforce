-- Vacation weekly-off control by job title.
-- Additive-only for the new v2 vacation module. Does not touch old leave objects.

begin;

create table if not exists public.v2_vacation_weekly_off_policies (
  id uuid primary key default gen_random_uuid(),
  job_title text not null,
  thursday_off text not null default 'working',
  friday_off text not null default 'full_day',
  saturday_off text not null default 'working',
  updated_by_login_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint v2_vacation_weekly_off_policies_title_unique unique (job_title),
  constraint v2_vacation_weekly_off_policies_title_not_blank check (btrim(job_title) <> ''),
  constraint v2_vacation_weekly_off_policies_thursday_check check (thursday_off in ('working', 'am_only', 'pm_only', 'full_day')),
  constraint v2_vacation_weekly_off_policies_friday_check check (friday_off in ('working', 'am_only', 'pm_only', 'full_day')),
  constraint v2_vacation_weekly_off_policies_saturday_check check (saturday_off in ('working', 'am_only', 'pm_only', 'full_day'))
);

create index if not exists v2_vacation_weekly_off_policies_title_idx
  on public.v2_vacation_weekly_off_policies (job_title);

alter table public.v2_vacation_weekly_off_policies enable row level security;

revoke all on table public.v2_vacation_weekly_off_policies from anon, authenticated;
grant select, insert, update, delete on table public.v2_vacation_weekly_off_policies to service_role;

drop policy if exists v2_vacation_weekly_off_policies_service_role_all
  on public.v2_vacation_weekly_off_policies;
create policy v2_vacation_weekly_off_policies_service_role_all
  on public.v2_vacation_weekly_off_policies
  for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';

commit;
