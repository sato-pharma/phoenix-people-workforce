alter table if exists public.employee_compensation
  add column if not exists payment_mode text not null default 'two_parts';

alter table if exists public.employee_compensation
  alter column payment_mode set default 'two_parts';

alter table if exists public.employee_compensation
  drop constraint if exists employee_compensation_payment_mode_check;

alter table if exists public.employee_compensation
  add constraint employee_compensation_payment_mode_check
  check (payment_mode in ('one_part', 'two_parts'));
