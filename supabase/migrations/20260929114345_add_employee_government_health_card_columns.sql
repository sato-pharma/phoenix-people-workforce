-- add_employee_government_health_card_columns
--
-- WHAT THIS CHANGES: three nullable columns on public.employees recording the GOVERNMENT health
--   insurance booklet — دفتر التأمين الصحى الحكومى, which HR calls "استلام بطاقة صحية":
--     health_card_status         whether the booklet has been received (yes / no / pending)
--     health_card_number         the booklet's number
--     health_card_received_date  the day it was received
-- WHY: the owner asked for them on the Employee Master sheet (2026-09-29), so HR can see and fill
--   them in the same row as everything else about a person. Nothing reads them yet beyond the
--   employee record, the master export and the master upload — they are a record, not a rule, and
--   no payroll figure is derived from any of them.
--   NOTE: this is the STATE booklet, deliberately separate from the company's PRIVATE medical
--   insurance, which already has its own medical_insurance_status / medical_insurance_number pair.
-- ROLLBACK:
--   alter table public.employees
--     drop column if exists health_card_status,
--     drop column if exists health_card_number,
--     drop column if exists health_card_received_date;
--   Additive and nullable: no existing row changes, no existing query reads these names, so the
--   rollback loses only whatever HR typed after the migration applied.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one is neither: it adds empty columns and rewrites no row.

begin;

alter table public.employees
  add column if not exists health_card_status text,
  add column if not exists health_card_number text,
  add column if not exists health_card_received_date date;

comment on column public.employees.health_card_status is
  'استلام بطاقة صحية — whether the GOVERNMENT health insurance booklet (دفتر التأمين الصحى الحكومى) has been received. yes / no / pending, or null when nobody has said. Not the company''s private medical insurance, which is medical_insurance_status.';

comment on column public.employees.health_card_number is
  'The government health insurance booklet number. Free text: the booklet is not always numbered the same way across governorates.';

comment on column public.employees.health_card_received_date is
  'The day the employee received the government health insurance booklet.';

commit;
