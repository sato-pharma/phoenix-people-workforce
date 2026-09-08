-- Record WHO a prepared WhatsApp message was for when that person is an employee, not a candidate.
--
-- `ats_whatsapp_template_sends.candidate_id` was the only target column, so a message prepared for
-- somebody already on the payroll recorded NULL there — indistinguishable from a manual send to a
-- number typed by hand. The probation templates make that the normal case rather than an edge one:
-- measured 2026-09-08, 30 people were inside their 90-day window and 29 of them had no candidate
-- record at all, so without this column nearly every probation message would be filed against
-- nobody.
--
-- TEXT, NOT A FOREIGN KEY, and deliberately so. `employees.hr_id` is text and MIXED CASE (`B-10`
-- and `b-10` are one person; every comparison in the app runs through `canonicalHrIdKey`), and this
-- table is an append-only record of what was PREPARED. A record of a past act must not stop being
-- readable because the person it names was later retired from the directory — the same reasoning
-- that keeps `candidate_id` free of a cascade.
--
-- ADDITIVE AND NULLABLE. Every existing row keeps its meaning: a NULL here and a NULL candidate_id
-- together still mean "typed by hand", which is what those rows were.

begin;

alter table public.ats_whatsapp_template_sends
  add column if not exists employee_hr_id text;

comment on column public.ats_whatsapp_template_sends.employee_hr_id is
  'The employee a message was prepared for, when the target was an employee rather than a candidate. Text rather than a FK because hr_id is mixed case and this table is an append-only record that must survive the person leaving the directory. NULL together with candidate_id means the number was typed by hand.';

create index if not exists ats_whatsapp_template_sends_employee_hr_id_idx
  on public.ats_whatsapp_template_sends (employee_hr_id)
  where employee_hr_id is not null;

commit;
