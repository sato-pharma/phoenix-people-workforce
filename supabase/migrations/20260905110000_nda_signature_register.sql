-- Hiring pack — THE CONFIDENTIALITY UNDERTAKING GETS A REAL SIGNATURE REGISTER.
--
-- WHY. When the six house papers shipped on 2026-09-05 all of them took a null binding in
-- `DOCUMENT_BINDINGS`, and five of those nulls are decisions: the two absence notices are issued
-- repeatedly, and the checklist, the service sheet and the two appointment-documents forms are
-- sheets filed in a drawer. The NDA was the one that did not fit that reasoning — it is signed ONCE
-- in a career, like the contract, and its date is worth having — and it was left null only because
-- doing it properly needed this migration. The note in `SIGNABLE_DOCUMENTS` said so rather than
-- leaving it to be rediscovered; the owner asked for it the same day.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────
--
-- 1. `nda_signed_date` — the date written on the paper, not the moment a button was pressed. A DATE
--    and not a timestamp, exactly like `contract_signed_date` beside it: a signature is dated by
--    hand in a room, and storing a time implies a precision nobody recorded.
--
-- 2. `nda_printed_at` — a timestamp, because that IS a machine event, so a reprint is visible
--    rather than silent. Same pair the contract and Form 1 already carry.
--
-- 3. The CHECK on `hiring_document_definitions.hiring_pack_document` gains 'nda'. THIS IS THE PART
--    THAT WOULD HAVE BITTEN: the constraint lists seven documents and rejects anything else, so the
--    checklist row below would have failed on insert with a constraint violation rather than a
--    missing-column error — and the surrounding code would have looked wrong instead of the data.
--    Nine other documents added since that CHECK was written are absent from it too and do not care,
--    because every one of them has a null `checklistName` and so never writes here.
--
-- 4. The checklist row itself, at display_order 86 — immediately after "Signed employment contract"
--    at 85, because the two are signed in the same conversation and a tracker that separates them
--    invites somebody to finish one and file the other.
--
-- ── IDEMPOTENT, AND WHY THAT MATTERS HERE ───────────────────────────────────────────────────────
--
-- The insert is guarded by NOT EXISTS on `hiring_pack_document`, not on `name`. There is no unique
-- constraint on either column — checked on production before writing this — so a re-run without a
-- guard would create a SECOND identical checklist row, and every employee's tracker would then show
-- the NDA twice with one of them permanently unticked. Keying the guard on the document rather than
-- the label also survives somebody renaming the row from the UI.
--
-- SAFE TO APPLY: two nullable columns on a satellite table (no rewrite, no lock of consequence, no
-- row touched) and one new row in a 15-row definitions table. Nothing existing is modified. Until
-- somebody marks an NDA signed, every read returns null and the card behaves exactly as it did
-- yesterday.

alter table public.employee_hiring_profile
  add column if not exists nda_signed_date date,
  add column if not exists nda_printed_at timestamptz;

comment on column public.employee_hiring_profile.nda_signed_date is
  'The date written on the confidentiality undertaking when it was signed. A DATE, like contract_signed_date: a signature is dated by hand, and a timestamp would imply a precision nobody recorded.';

comment on column public.employee_hiring_profile.nda_printed_at is
  'When the confidentiality undertaking was last printed, so a reprint is visible rather than silent.';

-- The CHECK is replaced rather than widened in place — Postgres has no ALTER CONSTRAINT for a CHECK
-- expression. Named identically so the next reader finds one constraint, not a numbered sibling.
alter table public.hiring_document_definitions
  drop constraint if exists hiring_document_definitions_hiring_pack_document_known;

alter table public.hiring_document_definitions
  add constraint hiring_document_definitions_hiring_pack_document_known
  check (
    hiring_pack_document is null
    or hiring_pack_document = any (array[
      'contract',
      'form1',
      'nda',
      'form6',
      'resignation',
      'mutualTermination',
      'clearanceEmployee',
      'clearanceCompany'
    ]::text[])
  );

insert into public.hiring_document_definitions (name, description, hiring_pack_document, display_order, is_active)
select
  'Signed confidentiality undertaking',
  'إقرار وتعهد بعدم إفشاء المعلومات والأسرار التجارية — supplements مادة (7) of the contract. Ticks itself when the undertaking is marked signed.',
  'nda',
  86,
  true
where not exists (
  select 1 from public.hiring_document_definitions where hiring_pack_document = 'nda'
);
