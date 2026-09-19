-- The Arabic HR letter (`salaryLetterAr`) joined HIRING_PACK_DOCUMENTS in src/lib/hiring-pack/types.ts,
-- the same 39th-built-in situation 20260913190000 fixed for the previous 28: it prints, opens in
-- Template Studio, and passes `parseDocumentFieldWrite`, then gets refused by Postgres at the last
-- step because `hiring_pack_document_fields_document_known` does not know its name yet.
--
-- THE PIN STAYS; ONLY ITS LIST GROWS — the same predicate, widened by one document, in the same
-- career order as HIRING_PACK_DOCUMENTS. `tests/hiring-pack-field-layout.test.ts` reads the NEWEST
-- migration that (re)defines this constraint and compares its list to HIRING_PACK_DOCUMENTS, so this
-- file has to be newer than 20260913190000 for that test to see the addition.
--
-- ROLLBACK: re-run the same statement without 'salaryLetterAr' in the list — only valid while no
-- hiring_pack_document_fields row for that document exists (a row would make the narrower CHECK fail
-- to add). Nothing here deletes or rewrites data.
--
-- SAFE ON EXISTING ROWS. Strictly wider than the constraint it replaces: every row the old predicate
-- admitted, this one admits too.

begin;

alter table public.hiring_pack_document_fields
  drop constraint if exists hiring_pack_document_fields_document_known;

alter table public.hiring_pack_document_fields
  add constraint hiring_pack_document_fields_document_known check (
    document in (
      'contract', 'form1',
      'workerDataForm',
      'custodyLaptop', 'custodyMobile',
      'nda', 'appointmentDocsReceipt', 'socialStatusSheet',
      'absenceWarning', 'deemedResignation',
      'disciplinaryWarning', 'disciplinaryPenalty', 'transferDecision', 'salaryAdjustment',
      'socialInsuranceAuthorization', 'healthInsuranceAuthorization', 'insurancePrintLetter',
      'appointmentDocsReturn', 'experienceCertificate', 'experienceCertificateEn',
      'handoverRecord', 'exitInterview',
      'salaryLetterEn', 'salaryLetterAr',
      'maternityCompensation', 'insuranceForm2', 'carInsuranceCertificate',
      'wageProgressSheet', 'officialHolidaysSheet', 'sickLeaveSheet', 'penaltiesSheet',
      'penaltyRegulationsApproval',
      'contractRenewal', 'contractNonRenewal',
      'form6', 'resignation', 'mutualTermination', 'clearanceEmployee', 'clearanceCompany'
    )
    or document ~* '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

comment on column public.hiring_pack_document_fields.document is
  'Which document these coordinates belong to: one of the built-in papers in HIRING_PACK_DOCUMENTS (src/lib/hiring-pack/types.ts), or a company template as custom:<uuid> where the uuid is the template''s stable key. The CHECK constraint mirrors asPrintableDocument in src/lib/hiring-pack/document-registry.ts, and tests/hiring-pack-field-layout.test.ts pins the list.';

commit;
