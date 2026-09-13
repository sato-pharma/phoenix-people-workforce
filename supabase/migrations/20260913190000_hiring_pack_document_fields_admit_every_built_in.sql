-- A box dropped on 28 of the 38 built-in papers could not be saved.
--
-- `hiring_pack_document_fields_document_known` still names the ten documents that existed when the
-- field layer was built (20260903201500, widened for company templates in 20260904200000). Every
-- built-in added since — the house papers, the renewal pair, the salary letter and the whole letters
-- pack of 2026-09-13 — prints, opens in Template Studio, passes `parseDocumentFieldWrite` (which
-- narrows through `asPrintableDocument`, i.e. the full `HIRING_PACK_DOCUMENTS`), and is then refused
-- by Postgres at the last step, as a raw constraint violation.
--
-- THE PIN STAYS; ONLY ITS LIST GROWS. The constraint's job is unchanged: a row naming a document this
-- system cannot print is a box that silently appears on no paper. So this is the same predicate with
-- the list brought level with `HIRING_PACK_DOCUMENTS` in src/lib/hiring-pack/types.ts, in that
-- file's career order. `tests/hiring-pack-field-layout.test.ts` compares the two lists, so the next
-- built-in added without a migration fails CI instead of failing a save.
--
-- SAFE ON EXISTING ROWS. Strictly wider than the constraint it replaces: every row the old predicate
-- admitted, this one admits. Production held no rows and staging six (`form1` and one company
-- template) when it was written.

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
      'salaryLetterEn',
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
