import { strict as assert } from "node:assert";

import {
  buildDeviceImportAuditInput,
  describeDeviceImportAttempt,
  gateRejectionKey,
  resetGateRejectionLimiterForTests,
  shouldLogGateRejection,
  type DeviceImportAttempt,
} from "../src/lib/devices/import-attempt-log.ts";

/**
 * The device import attempt log.
 *
 * WHAT THIS FILE PROTECTS. On 2026-09-08 the owner said three times that he had uploaded the first
 * tablet, and three times the register was empty. Nothing in the database could tell "he pressed
 * Import and every row was refused" from "the press never reached the server", because a device
 * that lands writes an audit row and a device that does not writes nothing whatsoever. Both look
 * like silence. An evening went on guessing at a question the system should have answered.
 *
 * So the attempt is now recorded separately from its result, and the thing that would quietly undo
 * that is a summary line which reads like success when nothing was written — the same defect the
 * screen banner had, reappearing in the audit log where nobody would notice it for months. That is
 * what the middle two tests below pin.
 *
 * The wording is asserted deliberately, not just the shape. This row exists to be READ by a person
 * scanning an audit list at speed, so "it contains the right numbers somewhere" is not the property
 * that matters; "it cannot be misread as a success" is.
 */

const base: DeviceImportAttempt = {
  stage: "import",
  actor: "B-10",
  fileName: "Device Custody - Walk The Fleet.xlsx",
  fileBytes: 48_128,
  rowsRead: 3,
  outcome: "ok",
};

/** The ordinary case: rows went in, and the summary says which and how many. */
function testASuccessfulImportSaysWhatLanded(): void {
  const summary = describeDeviceImportAttempt({
    ...base,
    imported: 3,
    issued: 2,
    skipped: 0,
    failed: 0,
  });

  assert.ok(
    summary.includes("3 row(s) read"),
    "the summary says how many rows the parser found, so a short file is visible as a short file",
  );
  assert.ok(summary.includes("3 imported"), "and how many landed");
  assert.ok(summary.includes("2 handed over"), "and how many were signed for");
  assert.ok(
    summary.includes("The register changed."),
    "and it states plainly that the register moved",
  );
  assert.ok(
    summary.includes("Walk The Fleet"),
    "the file name is in the summary, so a second attempt with the same sheet is recognisable",
  );
}

/**
 * THE ONE THAT MATTERS. An import can refuse every row and still answer 200 — a duplicate asset
 * tag is enough. If the audit row for that reads like a success, the log has the same defect the
 * screen had, in the place we would go to check the screen.
 */
function testAnImportThatWroteNothingNeverReadsLikeASuccess(): void {
  const summary = describeDeviceImportAttempt({
    ...base,
    imported: 0,
    issued: 0,
    skipped: 3,
    failed: 0,
  });

  assert.ok(
    summary.includes("Nothing was written"),
    'an import that wrote nothing must SAY nothing was written - it is the sentence that stops the audit log repeating the "Saved to the register. 0 devices" defect the screen had',
  );
  assert.ok(
    !summary.includes("The register changed."),
    "and it must not also claim the register changed - the two phrases are mutually exclusive by construction",
  );
  assert.ok(summary.includes("3 skipped"), "the refused rows are still counted, not hidden");
}

/**
 * A refusal before parsing — a file that is not the template, no file at all, a sheet with no
 * device on any row. This is the case that previously vanished entirely.
 */
function testARefusalIsRecordedAndNamesItsReason(): void {
  const summary = describeDeviceImportAttempt({
    ...base,
    rowsRead: null,
    outcome: "no_rows",
  });

  assert.ok(
    summary.includes("no_rows"),
    "the refusal code is in the summary, so the audit row and the message on screen name the same thing",
  );
  assert.ok(
    summary.includes("The register is unchanged."),
    "and it says the register did not move",
  );
  assert.ok(
    !summary.includes("imported"),
    "a refusal reports no counts at all - printing 0 imported would imply rows were considered",
  );
}

/** The check press writes nothing to the register, and its row must not suggest otherwise. */
function testTheCheckPressNeverClaimsAWrite(): void {
  const summary = describeDeviceImportAttempt({
    ...base,
    stage: "check",
    ready: 2,
    withProblems: 1,
  });

  assert.ok(
    summary.includes("Nothing was written"),
    "the check is a dry run and its audit row says so",
  );
  assert.ok(summary.includes("2 ready"), "it reports what the check found");
  assert.ok(summary.includes("1 with problems"), "including what it refused");
  assert.ok(
    !summary.includes("imported"),
    "and never uses the word imported, which is the other press",
  );
}

/**
 * The row that is actually written. The entity type is a closed TypeScript union, and an exhaustive
 * type does NOT gate this build (`ignoreBuildErrors`), so the value is asserted at runtime rather
 * than trusted to the compiler.
 */
function testTheAuditRowCarriesTheAttemptAsData(): void {
  const input = buildDeviceImportAuditInput({
    ...base,
    imported: 1,
    issued: 1,
    skipped: 2,
    failed: 0,
  });

  assert.equal(
    input.entityType,
    "device_import",
    "the attempt is its own entity type - filed under company_device it would be indistinguishable from a device that actually landed",
  );
  assert.equal(input.actorLoginId, "B-10", "the row names who tried");
  assert.equal(
    input.entityId,
    "Device Custody - Walk The Fleet.xlsx",
    "the file is the entity, so the audit list shows WHICH sheet was tried",
  );
  assert.equal(input.newValues.stage, "import", "the stage is machine-readable, not only in prose");
  assert.equal(input.newValues.imported, 1, "and so are the counts");
  assert.equal(input.newValues.skipped, 2, "including the refused rows");
  assert.equal(
    input.newValues.rowsRead,
    3,
    "rows read is kept apart from rows imported - the gap between them is the whole diagnostic",
  );
}

/** A file with no name still produces a readable row rather than the word "null". */
function testAnUnnamedFileStillReadsAsEnglish(): void {
  const summary = describeDeviceImportAttempt({ ...base, fileName: null, outcome: "missing_file" });
  assert.ok(summary.includes("an unnamed file"), "no file name yields prose, never a null");
  assert.ok(!summary.includes("null"), "and the word null never reaches an audit summary");
  assert.equal(
    buildDeviceImportAuditInput({ ...base, fileName: null }).entityId,
    null,
    "while the entity id stays a real null rather than the string",
  );
}

/**
 * A request refused by the gate is a THIRD thing, and it needs its own sentence.
 *
 * The reader's next question differs: not "what is wrong with my sheet" but "why was I not allowed
 * to try". Reusing the file-refusal wording would send somebody to inspect a spreadsheet that was
 * never opened.
 */
function testAGateRejectionSaysNoFileWasEverRead(): void {
  const summary = describeDeviceImportAttempt({
    ...base,
    rowsRead: null,
    fileName: null,
    outcome: "forbidden",
  });

  assert.ok(
    summary.includes("blocked before it started"),
    "a gate rejection is described as a block, not as a file that failed to import",
  );
  assert.ok(summary.includes("the permission check"), "and it names which gate refused it");
  assert.ok(
    summary.includes("No file was read"),
    "and says no file was read - otherwise it reads as a spreadsheet problem and sends the reader to the wrong place",
  );
  assert.ok(
    !summary.includes("row(s) read"),
    "a block reports no row counts at all, because no row was ever looked at",
  );

  const sameOrigin = describeDeviceImportAttempt({ ...base, outcome: "same_origin_rejected" });
  assert.ok(
    sameOrigin.includes("the same-origin check"),
    "the other gate is named distinctly - the two have completely different causes",
  );
}

/**
 * THE RATE LIMIT IS LOAD-BEARING, not tidiness. This row is written from a path any caller can
 * reach by POSTing at the route, so without a limit the diagnostic becomes a way of filling
 * `audit_logs` - burying the evidence it was added to provide.
 */
function testTheRejectionLogCannotBeUsedToFloodTheAuditTable(): void {
  resetGateRejectionLimiterForTests();
  const start = 1_000_000;

  assert.equal(
    shouldLogGateRejection("B-10:import:forbidden", start),
    true,
    "the first rejection from a caller is always recorded",
  );
  assert.equal(
    shouldLogGateRejection("B-10:import:forbidden", start + 1_000),
    false,
    "a second one a second later is refused - one press per second is a script, not a person",
  );
  assert.equal(
    shouldLogGateRejection("B-10:import:forbidden", start + 31_000),
    true,
    "and it opens again after the window, so a real person pressing repeatedly still leaves a visible pattern",
  );

  assert.equal(
    shouldLogGateRejection("B-10:check:forbidden", start + 1_000),
    true,
    "a different press is a different key - rate-limiting one must not silence the other",
  );
  assert.equal(
    shouldLogGateRejection("B-11:import:forbidden", start + 1_000),
    true,
    "and so is a different person, or one caller could mute everybody else's rows",
  );

  // The key the route actually passes. Asserted here because keying on the outcome alone would
  // still LOOK like a working rate limiter while letting one refused caller silence everyone.
  assert.notEqual(
    gateRejectionKey("B-10", "import", "forbidden"),
    gateRejectionKey("B-11", "import", "forbidden"),
    "two people refused the same way must not share a rate-limit bucket",
  );
  assert.notEqual(
    gateRejectionKey("B-10", "import", "forbidden"),
    gateRejectionKey("B-10", "check", "forbidden"),
    "and neither must the two presses",
  );
  assert.ok(
    gateRejectionKey("B-10", "import", "forbidden").includes("B-10"),
    "the caller is part of the key, not merely alongside it",
  );
}

export async function runDeviceImportAttemptLogTests(): Promise<void> {
  testASuccessfulImportSaysWhatLanded();
  testAnImportThatWroteNothingNeverReadsLikeASuccess();
  testARefusalIsRecordedAndNamesItsReason();
  testTheCheckPressNeverClaimsAWrite();
  testTheAuditRowCarriesTheAttemptAsData();
  testAnUnnamedFileStillReadsAsEnglish();
  testAGateRejectionSaysNoFileWasEverRead();
  testTheRejectionLogCannotBeUsedToFloodTheAuditTable();
}
