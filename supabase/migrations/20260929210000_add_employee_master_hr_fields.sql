-- add_employee_master_hr_fields
--
-- WHAT THIS CHANGES: twelve nullable columns on public.employees, the fields HR asked to keep on
--   the Employee Master row (Yasmeena Elsafory's rebuilt sheet, reviewed 2026-09-29):
--
--     birth_place                          محل الميلاد — birth place as written on the national ID
--     qualification                        المؤهل — the qualification itself ("Bachelor - license")
--     university_name                      الجامعة — the university, distinct from the college
--     college_major                        التخصص — the major read inside the college
--     senior_year                          سنة التخرج — graduation year, free text
--     contract_duration                    مدة العقد — "1 Year" and the like, free text
--     medical_insurance_card_received_date the day the PRIVATE medical insurance card was received
--     social_insurance_start_date          تاريخ بدء التأمين — the social insurance start date
--     kaab_elamaal_number                  كعب العمل — the labour registration stub's number
--     kaab_elamaal_issuer                  the office that issued it
--     kaab_elamaal_issue_date              the day it was issued
--     kaab_elamaal_refund                  whether its fee was refunded (yes / no)
--
--   NOTE ON THE COLLEGE. `employees.education` already holds what HR calls the COLLEGE — its live
--   values are Science, Pharmacy, Vet, Commerce, Dentist — so it is NOT renamed or moved: the
--   master sheet simply labels it "College Name", which is what it has always contained. The new
--   `qualification` column is the separate thing HR was missing (بكالوريوس / ليسانس).
--
-- WHY: the owner asked for Yasmeena's fields to be added to the Employee Master (2026-09-29), so a
--   person's whole HR record lives in one row instead of a private spreadsheet. These are a
--   record, not a rule: no payroll figure, no eligibility and no statutory filing is derived from
--   any of them. In particular kaab_elamaal_refund is a receipt fact, never a payment instruction.
--
-- ROLLBACK:
--   alter table public.employees
--     drop column if exists birth_place,
--     drop column if exists qualification,
--     drop column if exists university_name,
--     drop column if exists college_major,
--     drop column if exists senior_year,
--     drop column if exists contract_duration,
--     drop column if exists medical_insurance_card_received_date,
--     drop column if exists social_insurance_start_date,
--     drop column if exists kaab_elamaal_number,
--     drop column if exists kaab_elamaal_issuer,
--     drop column if exists kaab_elamaal_issue_date,
--     drop column if exists kaab_elamaal_refund;
--   Additive and nullable: no existing row changes and no existing query names these columns, so a
--   rollback loses only whatever HR typed after this applied. Dropping a column any SHIPPED build
--   still names is an outage, so a rollback ships the code that stops naming them first.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one is neither: it adds empty columns and rewrites no row.

begin;

alter table public.employees
  add column if not exists birth_place text,
  add column if not exists qualification text,
  add column if not exists university_name text,
  add column if not exists college_major text,
  add column if not exists senior_year text,
  add column if not exists contract_duration text,
  add column if not exists medical_insurance_card_received_date date,
  add column if not exists social_insurance_start_date date,
  add column if not exists kaab_elamaal_number text,
  add column if not exists kaab_elamaal_issuer text,
  add column if not exists kaab_elamaal_issue_date date,
  add column if not exists kaab_elamaal_refund text;

comment on column public.employees.birth_place is
  'محل الميلاد — birth place as written on the national ID. Free text.';

comment on column public.employees.qualification is
  'المؤهل — the qualification itself, e.g. "Bachelor - license". NOT the college: the college is employees.education, whose live values are Science, Pharmacy, Vet and the like.';

comment on column public.employees.university_name is
  'الجامعة — the university. Distinct from employees.education, which holds the college.';

comment on column public.employees.college_major is
  'التخصص — the major read inside the college.';

comment on column public.employees.senior_year is
  'سنة التخرج — graduation year. Free text rather than an integer: HR records it as written on the certificate, and some read "2019/2020".';

comment on column public.employees.contract_duration is
  'مدة العقد — the contract term as HR writes it, e.g. "1 Year". Free text; the dated fields are contract_start_date and contract_renewal_date.';

comment on column public.employees.medical_insurance_card_received_date is
  'The day the employee received the company''s PRIVATE medical insurance card. Not the government booklet, whose date is health_card_received_date.';

comment on column public.employees.social_insurance_start_date is
  'تاريخ بدء التأمين الاجتماعى — the day social insurance cover started. A record only: payroll reads social_insurance_wage and nothing else.';

comment on column public.employees.kaab_elamaal_number is
  'كعب العمل — the number on the labour registration stub.';

comment on column public.employees.kaab_elamaal_issuer is
  'The labour office that issued the كعب العمل stub.';

comment on column public.employees.kaab_elamaal_issue_date is
  'The day the كعب العمل stub was issued.';

comment on column public.employees.kaab_elamaal_refund is
  'Whether the كعب العمل fee was refunded to the employee — yes / no, or null when nobody has said. A receipt fact recorded by HR; it moves no money and no payroll run reads it.';

commit;
