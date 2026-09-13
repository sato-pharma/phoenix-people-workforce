-- Automated Payroll — standing additions (incentive / bonus that repeat on a cadence).
-- Owner request 2026-09-13: "every 3 months he should receive 60000 egp along side his salary".
--
-- Background. Part 2's Additions step is the one money step with no feeder: incentive, bonus and
-- overtime start at zero every month and are typed. An employee owed 60,000 EGP every three months
-- was paid it in February and May 2026 because somebody typed it, and was NOT paid it in August 2026
-- because nobody did — the August run published on 2026-09-08 with his incentive at 0. Nothing in
-- the module could have noticed.
--
-- This is the register that step now reads its recommendation FROM. It never pays anything by
-- itself: the amount is pre-filled into the Additions grid, with its reason, and HR still confirms
-- the step. A value HR already saved on the run's draft row always wins, so an adjusted or removed
-- amount is never overwritten.
--
--   every_months     null  -> a ONE-OFF, due only in first_month_key.
--                    n     -> due in first_month_key and every n months after it.
--   last_month_key   null  -> open-ended; otherwise the last month it may fall due.
--
-- RLS mirrors the rest of this module (see 20260830170000_automated_payroll_non_employee_recurring.sql):
-- service_role bypasses RLS; authenticated is gated by public.current_access_can_manage_employees();
-- no anon grant.

create table if not exists public.automated_payroll_standing_additions (
  id                      uuid primary key default gen_random_uuid(),
  employee_hr_id          text not null,
  employee_hr_id_compact  text not null,
  field                   text not null default 'incentive',
  amount                  numeric(14, 2) not null,
  every_months            integer,
  first_month_key         text not null,
  last_month_key          text,
  reason                  text not null,
  active                  boolean not null default true,
  created_by              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint automated_payroll_standing_additions_field_check
    check (field in ('incentive', 'bonus')),
  constraint automated_payroll_standing_additions_amount_check
    check (amount > 0),
  constraint automated_payroll_standing_additions_every_months_check
    check (every_months is null or every_months between 1 and 12),
  constraint automated_payroll_standing_additions_first_month_check
    check (first_month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint automated_payroll_standing_additions_last_month_check
    check (last_month_key is null or (last_month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and last_month_key >= first_month_key)),
  constraint automated_payroll_standing_additions_reason_check
    check (btrim(reason) <> '')
);

comment on table public.automated_payroll_standing_additions is
  'Incentive or bonus an employee is owed on a fixed cadence (or once). Read only as the RECOMMENDATION for the Part 2 Additions step; HR still confirms, and a value saved on the run draft row wins.';
comment on column public.automated_payroll_standing_additions.every_months is
  'null = one-off, due only in first_month_key; n = due in first_month_key and every n months after.';
comment on column public.automated_payroll_standing_additions.active is
  'Deactivate rather than delete — a deleted entry cannot explain a past month''s addition.';

create unique index if not exists automated_payroll_standing_additions_entry_idx
  on public.automated_payroll_standing_additions (employee_hr_id_compact, field, first_month_key);

create index if not exists automated_payroll_standing_additions_active_idx
  on public.automated_payroll_standing_additions (active);

alter table public.automated_payroll_standing_additions enable row level security;

drop policy if exists automated_payroll_standing_additions_admin_select on public.automated_payroll_standing_additions;
drop policy if exists automated_payroll_standing_additions_admin_insert on public.automated_payroll_standing_additions;
drop policy if exists automated_payroll_standing_additions_admin_update on public.automated_payroll_standing_additions;
drop policy if exists automated_payroll_standing_additions_admin_delete on public.automated_payroll_standing_additions;

create policy automated_payroll_standing_additions_admin_select on public.automated_payroll_standing_additions
  for select to authenticated using (public.current_access_can_manage_employees());
create policy automated_payroll_standing_additions_admin_insert on public.automated_payroll_standing_additions
  for insert to authenticated with check (public.current_access_can_manage_employees());
create policy automated_payroll_standing_additions_admin_update on public.automated_payroll_standing_additions
  for update to authenticated using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());
create policy automated_payroll_standing_additions_admin_delete on public.automated_payroll_standing_additions
  for delete to authenticated using (public.current_access_can_manage_employees());

revoke all on table public.automated_payroll_standing_additions from anon;
revoke all on table public.automated_payroll_standing_additions from public;
grant select, insert, update, delete on table public.automated_payroll_standing_additions to authenticated;
grant all on table public.automated_payroll_standing_additions to service_role;

-- The owner's two entries (2026-09-13), for Ali Mohamed Ali Elsayed, National Sales Manager.
--
--   1. The quarterly incentive, 60,000 EGP. Paid February and May 2026; the cadence continues
--      November, February, May, August. Anchored on 2026-11 — the next month it is due — so no
--      already-published month can ever be read as owing it.
--   2. August 2026's instalment, which was forgotten, paid ONCE with September 2026 as an exception.
--      After that the cadence returns to normal: nothing in October, the regular one in November.
--
-- Guarded on the employee existing so an environment without him applies cleanly, and idempotent on
-- the unique index so a re-run inserts nothing.
insert into public.automated_payroll_standing_additions
  (employee_hr_id, employee_hr_id_compact, field, amount, every_months, first_month_key, reason, created_by)
select e.hr_id, 'A12', 'incentive', 60000, 3, '2026-11',
       'Quarterly incentive, 60,000 EGP every 3 months (Nov, Feb, May, Aug)', 'B-10'
from public.employees e
where e.hr_id = 'A-12'
on conflict (employee_hr_id_compact, field, first_month_key) do nothing;

insert into public.automated_payroll_standing_additions
  (employee_hr_id, employee_hr_id_compact, field, amount, every_months, first_month_key, last_month_key, reason, created_by)
select e.hr_id, 'A12', 'incentive', 60000, null, '2026-09', '2026-09',
       'August 2026 quarterly incentive, missed in August and paid with September as a one-time exception', 'B-10'
from public.employees e
where e.hr_id = 'A-12'
on conflict (employee_hr_id_compact, field, first_month_key) do nothing;
