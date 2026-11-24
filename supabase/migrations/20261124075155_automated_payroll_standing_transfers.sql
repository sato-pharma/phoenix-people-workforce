-- Automated Payroll — standing transfers: part of an employee's salary paid to a non-employee, every
-- month for a fixed window.
--
-- Owner request 2026-11-24: "deduct 1500 from omar gawish from first part and 1500 from the second
-- part and put the first 1500 with the non employees with anwar gawish and the second 1500 with the
-- second part with anwar gawish", then "starting from november 2026 and 11 months ahead".
--
-- One row is one instalment of one transfer. While a month falls inside [first_month_key,
-- last_month_key]:
--   * the employee's deduction for that part is PRE-FILLED — Part 1 on Special Situations (Apply To:
--     First Part), Part 2 on "Any more deductions?" — and HR still confirms the step; a figure HR
--     already saved on the draft row always wins;
--   * the payee gets a line of that amount on the run's Non-Employees list for that part, linked
--     back here by automated_payroll_non_employees.standing_transfer_id (one per run per transfer).
-- It never pays anybody by itself, and it never edits a line HR typed.
--
-- Additive only: one new table, one nullable column, indexes, a registry row. No application data is
-- changed except the two register rows below.

begin;

create table if not exists public.automated_payroll_standing_transfers (
  id                       uuid primary key default gen_random_uuid(),
  employee_hr_id           text not null,
  employee_hr_id_compact   text not null,
  part                     text not null,
  amount                   numeric(14, 2) not null,
  first_month_key          text not null,
  last_month_key           text not null,
  payee_full_name_en       text not null,
  payee_full_name_ar       text not null,
  payee_bank_name          text not null,
  payee_bank_account       text not null,
  reason                   text not null,
  active                   boolean not null default true,
  created_by               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint automated_payroll_standing_transfers_part_check
    check (part in ('first', 'second')),
  constraint automated_payroll_standing_transfers_amount_check
    check (amount > 0),
  constraint automated_payroll_standing_transfers_first_month_check
    check (first_month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint automated_payroll_standing_transfers_last_month_check
    check (last_month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and last_month_key >= first_month_key),
  constraint automated_payroll_standing_transfers_payee_check
    check (btrim(payee_full_name_en) <> '' and btrim(payee_full_name_ar) <> ''
           and btrim(payee_bank_name) <> '' and btrim(payee_bank_account) <> ''),
  constraint automated_payroll_standing_transfers_reason_check
    check (btrim(reason) <> ''),
  constraint automated_payroll_standing_transfers_phx_employee_fkey
    foreign key (employee_hr_id) references public.employees(hr_id) on update cascade on delete restrict
);

comment on table public.automated_payroll_standing_transfers is
  'Part of an employee''s salary paid to a non-employee each month in a window. Pre-fills the employee''s deduction for that part (HR confirms) and seeds the payee''s line on that part''s Non-Employees list.';
comment on column public.automated_payroll_standing_transfers.active is
  'Deactivate rather than delete — a deleted entry cannot explain a past month''s deduction or line.';

create unique index if not exists automated_payroll_standing_transfers_entry_idx
  on public.automated_payroll_standing_transfers (employee_hr_id_compact, part, payee_bank_account, first_month_key);

create index if not exists automated_payroll_standing_transfers_employee_hr_id_fk_idx
  on public.automated_payroll_standing_transfers (employee_hr_id);

alter table public.automated_payroll_standing_transfers enable row level security;

-- No grant to anon or authenticated: every read and write goes through the service role.
revoke all on table public.automated_payroll_standing_transfers from anon;
revoke all on table public.automated_payroll_standing_transfers from public;
grant all on table public.automated_payroll_standing_transfers to service_role;

-- The payee line's provenance, the same way recurring_id marks a line copied from the standing list.
alter table public.automated_payroll_non_employees
  add column if not exists standing_transfer_id uuid
    references public.automated_payroll_standing_transfers(id) on delete restrict;

comment on column public.automated_payroll_non_employees.standing_transfer_id is
  'The standing transfer this line was seeded from, or null. One line per run per transfer.';

create unique index if not exists automated_payroll_non_employees_run_transfer_idx
  on public.automated_payroll_non_employees (run_id, standing_transfer_id)
  where standing_transfer_id is not null;

create index if not exists automated_payroll_non_employees_standing_transfer_id_fk_idx
  on public.automated_payroll_non_employees (standing_transfer_id);

-- Covered by the undo log like every other payroll money table (REC-036).
insert into recovery.protected_tables (source_schema, source_table, pk_columns, note, max_versions)
values ('public', 'automated_payroll_standing_transfers', array['id'], 'REC-036 standing transfers', 72)
on conflict do nothing;

-- The owner's two entries (2026-11-24): 1,500 EGP from each part of Omar Anwar Ibrahim Ahmed Gawish's
-- salary to Anwar Ibrahim Ahmed Ibrahim Gaweesh, paid on that part's Non-Employees list, November
-- 2026 and the 11 months after it (to October 2027). The payee's bank and account are the ones his
-- own Non-Employees lines have carried every month since July 2026.
insert into public.automated_payroll_standing_transfers
  (employee_hr_id, employee_hr_id_compact, part, amount, first_month_key, last_month_key,
   payee_full_name_en, payee_full_name_ar, payee_bank_name, payee_bank_account, reason, created_by)
select e.hr_id, 'b10', p.part, 1500, '2026-11', '2027-10',
       'Anwar Ibrahim Ahmed Ibrahim Gaweesh', 'أنور إبراهيم أحمد إبراهيم جاويش', 'CIB', '100023050538',
       'Transfer to Anwar Ibrahim Ahmed Ibrahim Gaweesh, 1,500 EGP from each part, November 2026 to October 2027',
       'B-10'
from public.employees e
cross join (values ('first'), ('second')) as p(part)
where e.hr_id = 'B-10'
on conflict (employee_hr_id_compact, part, payee_bank_account, first_month_key) do nothing;

commit;
