-- phoenix_crm_camera_day_allowances
--
-- WHAT THIS CHANGES: one new table, public.phoenix_crm_camera_day_allowances — how many Phoenix Camera visits the
--   Super Admin opened for ONE rep on ONE Phoenix day, above the daily limit (phoenix_crm_settings.camera_daily_cap,
--   3). Each row keeps the manager's email approval it was opened on, who opened it and when. Service role only.
-- WHY: owner, 21 Nov 2026: every camera visit goes to manual review first; "U ARE ALLOWED 3 A DAYS IF MORE NEEDED WE
--   NEED APPROVAL FROM MANAGERS VIA EMAIL AND SYSTEM ADMIN WILL UPDATE IT FOR THIS DAY ONLY". Approve on Camera
--   reviews refuses a visit past the rep's allowance for that day until this row raises it.
-- ROLLBACK: drop table if exists public.phoenix_crm_camera_day_allowances;  (only the raised days are lost; no
--   visit, camera item or setting depends on the table existing)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new, empty table.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_camera_day_allowances (
  rep_hr_id text not null check (char_length(rep_hr_id) between 1 and 40),
  day date not null,
  is_test boolean not null default false,
  allowance integer not null check (allowance >= 1 and allowance <= 20),
  manager_approval text not null check (char_length(btrim(manager_approval)) between 3 and 500),
  set_by_hr_id text not null check (char_length(set_by_hr_id) between 1 and 40),
  set_at timestamptz not null default now(),
  primary key (rep_hr_id, day, is_test)
);

alter table public.phoenix_crm_camera_day_allowances enable row level security;
drop policy if exists phoenix_crm_camera_day_allowances_service_role on public.phoenix_crm_camera_day_allowances;
create policy phoenix_crm_camera_day_allowances_service_role
  on public.phoenix_crm_camera_day_allowances for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_camera_day_allowances from public, anon, authenticated;
grant all on table public.phoenix_crm_camera_day_allowances to service_role;

notify pgrst, 'reload schema';

commit;
