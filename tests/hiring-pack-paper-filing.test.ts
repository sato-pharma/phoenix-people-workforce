import assert from "node:assert/strict";

import {
  buildIssuedFileName,
  FILEABLE_BUILT_IN_DOCUMENTS,
  isFileableBuiltIn,
  isFilingSchemaMissing,
  resolveBuiltInFilingSlot,
  resolveCustomFilingSlot,
  type FilingSlotRow,
} from "@/lib/hiring-pack/paper-filing";
import { SIGNABLE_DOCUMENTS } from "@/lib/hiring-pack/types";

// Filing a confirmed paper into the employee's hiring documents.
//
// WHAT IS WORTH PINNING IS WHERE IT GOES, and above all where it does NOT go. Every failure this
// module can have is silent by nature: a contract filed into the wrong slot looks exactly like a
// contract filed into the right one until somebody goes looking for it months later, and a paper
// that quietly files nowhere looks exactly like a paper nobody has signed yet. So the tests are
// about refusals as much as about matches.

const SLOTS: FilingSlotRow[] = [
  { hiring_pack_document: "contract", id: "def-contract", is_active: true, name: "Signed employment contract" },
  { hiring_pack_document: "form1", id: "def-form1", is_active: true, name: "Social insurance form" },
  { hiring_pack_document: "form6", id: "def-form6", is_active: false, name: "Signed social insurance Form 6" },
  { hiring_pack_document: null, id: "def-birth", is_active: true, name: "Birth certificate" },
  { hiring_pack_document: null, id: "def-custom-target", is_active: true, name: "Medical check" },
  { hiring_pack_document: null, id: "def-retired", is_active: false, name: "Personal photos" },
];

/**
 * The two lists are kept separate on purpose and must still agree, so this asserts the agreement
 * rather than the derivation. If a document is ever made signable without a filing rule, this is
 * the line that says so — and it is a decision to take deliberately, not a mismatch to discover
 * after four months of papers have failed to file.
 */
function testEverySignablePaperHasAFilingRule() {
  const signable = [...SIGNABLE_DOCUMENTS].sort();
  const fileable = [...FILEABLE_BUILT_IN_DOCUMENTS].sort();
  assert.deepEqual(
    fileable,
    signable,
    "every signable paper should have a filing rule, and nothing else should",
  );

  assert.equal(isFileableBuiltIn("contract"), true);
  // The custody receipts and the worker data form record no signature and file nothing.
  assert.equal(isFileableBuiltIn("custodyLaptop"), false);
  assert.equal(isFileableBuiltIn("workerDataForm"), false);
}

function testAPaperFilesIntoTheSlotThatNamesIt() {
  const decision = resolveBuiltInFilingSlot("contract", SLOTS);
  assert.equal(decision.filed, true);
  assert.equal(decision.filed && decision.definitionId, "def-contract");
  assert.equal(decision.filed && decision.slotName, "Signed employment contract");

  const form1 = resolveBuiltInFilingSlot("form1", SLOTS);
  assert.equal(form1.filed && form1.definitionId, "def-form1");
}

/**
 * THE ONE THAT MATTERS MOST. A slot is matched on the pinned column, never on its name — the name
 * is admin-editable free text. Renaming "Signed employment contract" must not move where a contract
 * files, and must not stop it filing either.
 */
function testRenamingASlotDoesNotMoveWhereAPaperFiles() {
  const renamed: FilingSlotRow[] = SLOTS.map((row) =>
    row.id === "def-contract" ? { ...row, name: "Employment contract (signed copy)" } : row,
  );
  const decision = resolveBuiltInFilingSlot("contract", renamed);
  assert.equal(decision.filed, true, "a renamed slot still takes the paper it is pinned to");
  assert.equal(decision.filed && decision.definitionId, "def-contract");

  // And a slot whose NAME looks right but which is pinned to nothing takes no paper at all.
  const decoy: FilingSlotRow[] = [
    { hiring_pack_document: null, id: "def-decoy", is_active: true, name: "Signed employment contract" },
  ];
  const refused = resolveBuiltInFilingSlot("contract", decoy);
  assert.equal(refused.filed, false, "a same-named slot with no pin is not a match");
}

function testAPaperWithNowhereToGoIsRefusedRatherThanGuessed() {
  const withoutResignation = resolveBuiltInFilingSlot("resignation", SLOTS);
  assert.equal(withoutResignation.filed, false);
  assert.match(
    withoutResignation.filed ? "" : withoutResignation.why,
    /no checklist slot names this paper/i,
    "the refusal says what is missing and where to fix it",
  );

  // A retired slot is refused HERE rather than deeper down, where the message would be about a
  // checklist the person never mentioned.
  const retired = resolveBuiltInFilingSlot("form6", SLOTS);
  assert.equal(retired.filed, false);
  assert.match(retired.filed ? "" : retired.why, /retired/i);
  assert.match(
    retired.filed ? "" : retired.why,
    /Signed social insurance Form 6/,
    "and it names the slot, so it can be found",
  );
}

function testACompanyTemplateFilesOnlyWhereItWasPointed() {
  const unset = resolveCustomFilingSlot(null, SLOTS);
  assert.equal(unset.filed, false, "unset is the normal state, not a fault");
  assert.match(unset.filed ? "" : unset.why, /does not file anywhere yet/i);

  const pointed = resolveCustomFilingSlot("def-custom-target", SLOTS);
  assert.equal(pointed.filed, true);
  assert.equal(pointed.filed && pointed.slotName, "Medical check");

  const gone = resolveCustomFilingSlot("def-that-was-deleted", SLOTS);
  assert.equal(gone.filed, false);
  assert.match(gone.filed ? "" : gone.why, /no longer exists/i);

  const retired = resolveCustomFilingSlot("def-retired", SLOTS);
  assert.equal(retired.filed, false);
  assert.match(retired.filed ? "" : retired.why, /retired/i);
}

/**
 * A company template can NEVER reach a built-in paper's slot by accident, and a built-in can never
 * reach a template's. They are resolved by two different mechanisms pointing in two directions, and
 * this is the line that would fail if somebody unified them "for symmetry".
 */
function testTheTwoResolutionsCannotCrossOver() {
  // Pointing a template at the contract's slot is legal — the owner may genuinely want that — but
  // it must be an explicit id, never inferred from the paper's identity.
  const explicit = resolveCustomFilingSlot("def-contract", SLOTS);
  assert.equal(explicit.filed, true, "an explicit pointer at any live slot is honoured");

  // And no built-in resolves off a template's column: passing the column's value as a document name
  // finds nothing.
  const crossed = resolveBuiltInFilingSlot("def-contract", SLOTS);
  assert.equal(crossed.filed, false, "a definition id is not a document name");
}

function testTheFileNameSaysWhatItIsWithoutTheSystem() {
  const name = buildIssuedFileName({ hrId: "hr-010", label: "Contract", signedDate: "2026-09-04" });
  assert.equal(name, "Contract — HR-010 — signed 2026-09-04 (issued).pdf");

  // A colon in a template's name truncates the whole filename on Windows at download time.
  const awkward = buildIssuedFileName({
    hrId: "PD-0001",
    label: 'Enrolment: "new" form/v2',
    signedDate: "2026-01-31",
  });
  assert.equal(awkward.includes(":"), false, "no colon survives into a downloaded name");
  assert.equal(awkward.includes("/"), false);
  assert.equal(awkward.includes('"'), false);
  // The stripped punctuation collapses rather than leaving a double space, so the name reads as a
  // name instead of as something that has been through a filter.
  assert.equal(awkward, "Enrolment new form v2 — PD-0001 — signed 2026-01-31 (issued).pdf");

  // The date in the name is the one passed in — the date on the paper — never today's.
  assert.match(
    buildIssuedFileName({ hrId: "AI-0002", label: "Form 1", signedDate: "2025-12-01" }),
    /signed 2025-12-01/,
  );
}

/**
 * The deploy-before-migration window, which is a real window and not a hypothetical one: merging to
 * `main` ships to production immediately, and applying the migration is a separate deliberate act.
 *
 * THE CODE THAT MATTERS IS `PGRST205`. A missing table answers that, through PostgREST's schema
 * cache, rather than Postgres's `42P01` — so the guard everybody writes first fires never, and the
 * window 500s instead of explaining itself. `23514` is the other easy one to miss: after the column
 * exists, the `source` CHECK still refuses 'issued' until 20260904233000 lands.
 */
function testTheUnmigratedWindowIsRecognisedRatherThanThrown() {
  assert.equal(isFilingSchemaMissing({ code: "PGRST205" }), true, "a missing table, via PostgREST");
  assert.equal(isFilingSchemaMissing({ code: "PGRST204" }), true, "a missing column, via PostgREST");
  assert.equal(isFilingSchemaMissing({ code: "42P01" }), true, "a missing table, via Postgres");
  assert.equal(isFilingSchemaMissing({ code: "42703" }), true, "a missing column, via Postgres");
  assert.equal(
    isFilingSchemaMissing({ code: "23514", message: 'violates check constraint "hiring_document_files_source_check"' }),
    true,
    "the column exists but the CHECK predates 'issued'",
  );

  // And by message, for the paths that lose the code on the way back.
  assert.equal(
    isFilingSchemaMissing({ message: "Could not find the 'hiring_pack_document' column in the schema cache" }),
    true,
  );
  assert.equal(isFilingSchemaMissing({ message: 'column "hiring_pack_document" does not exist' }), true);

  // A REAL FAULT MUST STILL THROW. This guard turns an error into a banner that says the signature
  // was recorded and nothing was filed; swallowing a genuine failure that way would report a
  // working system while papers silently stopped being filed.
  assert.equal(isFilingSchemaMissing({ code: "23505", message: "duplicate key value" }), false);
  assert.equal(isFilingSchemaMissing({ code: "42501", message: "permission denied" }), false);
  assert.equal(isFilingSchemaMissing(new Error("fetch failed")), false);
  assert.equal(isFilingSchemaMissing(null), false);
  assert.equal(isFilingSchemaMissing("PGRST205"), false, "a bare string is not an error object");
}

export async function runHiringPackPaperFilingTests() {
  testEverySignablePaperHasAFilingRule();
  testAPaperFilesIntoTheSlotThatNamesIt();
  testRenamingASlotDoesNotMoveWhereAPaperFiles();
  testAPaperWithNowhereToGoIsRefusedRatherThanGuessed();
  testACompanyTemplateFilesOnlyWhereItWasPointed();
  testTheTwoResolutionsCannotCrossOver();
  testTheFileNameSaysWhatItIsWithoutTheSystem();
  testTheUnmigratedWindowIsRecognisedRatherThanThrown();
}
