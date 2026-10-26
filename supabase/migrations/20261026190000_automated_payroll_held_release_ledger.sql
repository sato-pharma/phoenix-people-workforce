-- Held Salary Release — the ledger of what PAYROLL released of an earlier month's held salary.
--
-- 20261026180000 added the step's figure (draft_rows.held_release_value). This table records what a
-- run actually releases against each held month, so the same held money is never paid twice.
--
-- WHY NOT automated_payroll_held_settlements. That table is a human ATTESTATION of a by-hand
-- transfer, one row per (held run, person), which HR records, corrects and withdraws on the
-- held-salary sheet. Sharing its row with payroll meant a by-hand edit could overwrite what a payroll
-- run paid (re-opening a debt already paid), and a payroll release could overwrite a by-hand bank
-- reference. So payroll writes here, and the outstanding balance is
--   withheld - settled by hand - released by payroll.
--
-- ONE ROW PER (paying run, held run, person). A paying run REPLACES its own rows each time it records
-- (Part 2 confirm reserves, publish records), so a re-confirm or a retried publish never adds a second
-- allocation. Rows of a cancelled paying run count for nothing (it paid nobody); rows of a confirmed,
-- not-yet-published run DO count, because its Part 2 bank files can already have paid the money.
--
-- RLS mirrors 20260910180000_automated_payroll_held_settlements.sql exactly.
-- Additive. Rollback: drop table if exists public.automated_payroll_held_releases;

create table if not exists public.automated_payroll_held_releases (
  id                      uuid primary key default gen_random_uuid(),
  -- The run whose Part 2 pays the release.
  paying_run_id           uuid not null references public.automated_payroll_runs(id) on delete cascade,
  -- The earlier published run that withheld the money.
  held_run_id             uuid not null references public.automated_payroll_runs(id) on delete cascade,
  employee_hr_id          text not null,
  employee_hr_id_compact  text not null,
  amount                  numeric(14, 2) not null,
  recorded_by             text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint automated_payroll_held_releases_amount_check check (amount >= 0)
);

create unique index if not exists automated_payroll_held_releases_pay_held_employee_idx
  on public.automated_payroll_held_releases (paying_run_id, held_run_id, employee_hr_id_compact);

create index if not exists automated_payroll_held_releases_held_idx
  on public.automated_payroll_held_releases (held_run_id, employee_hr_id_compact);

alter table public.automated_payroll_held_releases enable row level security;

drop policy if exists automated_payroll_held_releases_admin_select on public.automated_payroll_held_releases;
drop policy if exists automated_payroll_held_releases_admin_insert on public.automated_payroll_held_releases;
drop policy if exists automated_payroll_held_releases_admin_update on public.automated_payroll_held_releases;
drop policy if exists automated_payroll_held_releases_admin_delete on public.automated_payroll_held_releases;

create policy automated_payroll_held_releases_admin_select on public.automated_payroll_held_releases
  for select to authenticated using (public.current_access_can_manage_employees());
create policy automated_payroll_held_releases_admin_insert on public.automated_payroll_held_releases
  for insert to authenticated with check (public.current_access_can_manage_employees());
create policy automated_payroll_held_releases_admin_update on public.automated_payroll_held_releases
  for update to authenticated using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());
create policy automated_payroll_held_releases_admin_delete on public.automated_payroll_held_releases
  for delete to authenticated using (public.current_access_can_manage_employees());

revoke all on table public.automated_payroll_held_releases from anon;
revoke all on table public.automated_payroll_held_releases from public;
grant select, insert, update, delete on table public.automated_payroll_held_releases to authenticated;
grant all on table public.automated_payroll_held_releases to service_role;

comment on table public.automated_payroll_held_releases is
  'What a payroll run released of an earlier month''s held salary, per (paying run, held run, person). Separate from the by-hand held settlements. Outstanding held = withheld - settled by hand - released here (cancelled paying runs ignored).';
comment on column public.automated_payroll_draft_rows.held_release_value is
  'Held Salary Release step -> amount of an earlier month''s withheld salary paid in this month''s Part 2 (Other Additions). Never above the outstanding held balance; Part 2 confirm reserves it and publish records it in automated_payroll_held_releases.';
