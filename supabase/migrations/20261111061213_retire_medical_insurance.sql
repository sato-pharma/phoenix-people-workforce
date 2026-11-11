-- retire_medical_insurance
-- SAFE: the Medical Insurance module is retired (owner, 2026-11-11, "Export, then drop") — every row was
-- exported to an Excel workbook outside the repo before this ran; see docs/medical-insurance-retired.md.
--
-- WHAT THIS CHANGES: drops the storage policy medical_insurance_service_role and the seven
-- medical_insurance_* tables that 20261104092817_medical_insurance.sql and
-- 20261104142651_medical_insurance_category_choices.sql created, children first. The private
-- `medical-insurance` storage bucket itself is emptied and deleted through the Storage API, never
-- here (storage.protect_delete refuses a delete from storage.objects in SQL).
-- WHY: Sato Pharma cancelled the MetLife group medical contract the module was built for and is
-- renewing with another insurer. The module's code leaves in the same pull request.
-- NOT TOUCHED: the payroll deduction column medical_insurance on employees, employee_compensation and
-- salary_records, and employees.medical_insurance_status / medical_insurance_number. They are a
-- different, older feature.
-- ROLLBACK: none in place. Re-running the two 2026-11-04 migrations recreates the empty tables; the
-- data (1 policy, 114 members, nothing else) comes back only from the exported workbook.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists medical_insurance_service_role on storage.objects';
  end if;
end $$;

drop table if exists public.medical_insurance_invoice_lines;
drop table if exists public.medical_insurance_invoices;
drop table if exists public.medical_insurance_documents;
drop table if exists public.medical_insurance_exceptions;
drop table if exists public.medical_insurance_category_choices;
drop table if exists public.medical_insurance_members;
drop table if exists public.medical_insurance_policies;

commit;

notify pgrst, 'reload schema';
