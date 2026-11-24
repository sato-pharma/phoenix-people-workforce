-- hiring_pack_hospital_authorization
--
-- WHAT THIS CHANGES: one nullable column, employee_hiring_profile.authorization_hospital_ar (text), and
-- the CHECK on hiring_pack_document_fields.document replaced by one that also admits
-- 'hospitalAuthorization'. The document list is the live production definition read on 2026-11-24
-- plus the one new name; the custom:<uuid> branch is unchanged.
--
-- WHY: the owner, 2026-11-24 — a medical rep visits a hospital only with a company letter naming that
-- ONE hospital (the first was for Dr Rania Alaa at Kafr El Sheikh University Hospital). HR Forms now
-- prints it for every rep: the hospital is typed on the paper and kept on the person's hiring
-- profile, and a moved field on the paper is stored against document 'hospitalAuthorization'.
--
-- ADDITIVE: no row is touched. The constraint admits strictly more than the old one did.
--
-- ROLLBACK:
--   alter table public.employee_hiring_profile drop column if exists authorization_hospital_ar;
--   and restore the previous constraint without 'hospitalAuthorization' — possible only while no
--   hiring_pack_document_fields row names that document.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.employee_hiring_profile
  add column if not exists authorization_hospital_ar text;

comment on column public.employee_hiring_profile.authorization_hospital_ar is
  'The one hospital this person''s hospital authorisation letter is addressed to, in Arabic, typed by HR on the paper. Null prints blank rules for HR to fill.';

alter table public.hiring_pack_document_fields
  drop constraint if exists hiring_pack_document_fields_document_known;

alter table public.hiring_pack_document_fields
  add constraint hiring_pack_document_fields_document_known check (
    document = any (array[
      'contract', 'form1', 'workerDataForm', 'custodyLaptop', 'custodyMobile', 'nda',
      'appointmentDocsReceipt', 'socialStatusSheet', 'absenceWarning', 'deemedResignation',
      'disciplinaryWarning', 'disciplinaryPenalty', 'transferDecision', 'salaryAdjustment',
      'socialInsuranceAuthorization', 'healthInsuranceAuthorization', 'insurancePrintLetter',
      'appointmentDocsReturn', 'experienceCertificate', 'experienceCertificateEn', 'handoverRecord',
      'exitInterview', 'salaryLetterEn', 'salaryLetterAr', 'maternityCompensation', 'insuranceForm2',
      'carInsuranceCertificate', 'wageProgressSheet', 'officialHolidaysSheet', 'sickLeaveSheet',
      'penaltiesSheet', 'penaltyRegulationsApproval', 'contractRenewal', 'contractNonRenewal',
      'form6', 'resignation', 'mutualTermination', 'clearanceEmployee', 'clearanceCompany',
      'hospitalAuthorization'
    ]::text[])
    or document ~* '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

commit;
