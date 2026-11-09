-- automated_payroll_held_entered — the held amount HR types for a month that did not record names.
--
-- WHAT THIS CHANGES: adds public.automated_payroll_held_entered, one row per (held run, person): the
--   amount an EARLIER published run withheld from that person, typed by HR on the Held Salary Release
--   step, with a required note.
-- WHY: the Held Salary Release step reads what each published run withheld from that run's
--   `published` audit row (detail.held). The July 2026 and August 2026 runs were published before that
--   list existed — their detail is only {batchId, heldExcluded, publishedCount} — so a person held in
--   either month has no balance, never appears on the step, and no release can be saved for them.
--   The owner decided HR types the held amount. The entry counts ONLY for a run that kept the count
--   alone; a run that recorded each held person ignores it, so it can never double a recorded figure.
--   RLS, policies and grants mirror automated_payroll_held_part1_unpaid
--   (20261026210000_automated_payroll_part1_withheld_and_pay_deferral.sql) exactly.
-- ROLLBACK: drop table if exists public.automated_payroll_held_entered;
--   Additive: nothing existing changes, so dropping it loses only what HR has typed into it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create table if not exists public.automated_payroll_held_entered (
  id                      uuid primary key default gen_random_uuid(),
  -- The earlier published run (a month that kept only the count) that withheld this person's pay.
  held_run_id             uuid not null references public.automated_payroll_runs(id) on delete cascade,
  employee_hr_id          text not null,
  employee_hr_id_compact  text not null,
  employee_name           text,
  amount                  numeric(14, 2) not null,
  -- Why HR knows the figure (the sheet, the bank file, the decision). Required: an unexplained
  -- number that creates a debt is the state this table exists to replace.
  note                    text not null,
  -- The run on whose Held Salary Release step it was recorded.
  recorded_in_run_id      uuid references public.automated_payroll_runs(id) on delete set null,
  recorded_by             text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint automated_payroll_held_entered_amount_check check (amount > 0),
  constraint automated_payroll_held_entered_note_check check (length(btrim(note)) > 0)
);

create unique index if not exists automated_payroll_held_entered_run_employee_idx
  on public.automated_payroll_held_entered (held_run_id, employee_hr_id_compact);

alter table public.automated_payroll_held_entered enable row level security;

drop policy if exists automated_payroll_held_entered_admin_select on public.automated_payroll_held_entered;
drop policy if exists automated_payroll_held_entered_admin_insert on public.automated_payroll_held_entered;
drop policy if exists automated_payroll_held_entered_admin_update on public.automated_payroll_held_entered;
drop policy if exists automated_payroll_held_entered_admin_delete on public.automated_payroll_held_entered;

create policy automated_payroll_held_entered_admin_select on public.automated_payroll_held_entered
  for select to authenticated using (public.current_access_can_manage_employees());
create policy automated_payroll_held_entered_admin_insert on public.automated_payroll_held_entered
  for insert to authenticated with check (public.current_access_can_manage_employees());
create policy automated_payroll_held_entered_admin_update on public.automated_payroll_held_entered
  for update to authenticated using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());
create policy automated_payroll_held_entered_admin_delete on public.automated_payroll_held_entered
  for delete to authenticated using (public.current_access_can_manage_employees());

revoke all on table public.automated_payroll_held_entered from anon;
revoke all on table public.automated_payroll_held_entered from public;
grant select, insert, update, delete on table public.automated_payroll_held_entered to authenticated;
grant all on table public.automated_payroll_held_entered to service_role;

comment on table public.automated_payroll_held_entered is
  'HR-typed held amount for a person an earlier published run withheld, for a run published before the payroll kept each held person (July and August 2026). Counts only for a run whose published audit row has no held list; ignored for a run that recorded names.';
comment on column public.automated_payroll_held_entered.note is
  'Why HR knows the figure. Required.';
comment on column public.automated_payroll_held_entered.recorded_in_run_id is
  'The run on whose Held Salary Release step the amount was entered.';

commit;
