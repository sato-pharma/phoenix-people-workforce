import { strict as assert } from "node:assert";

import {
  buildDeviceImportAuditInput,
  describeDeviceImportAttempt,
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

export async function runDeviceImportAttemptLogTests(): Promise<void> {
  testASuccessfulImportSaysWhatLanded();
  testAnImportThatWroteNothingNeverReadsLikeASuccess();
  testARefusalIsRecordedAndNamesItsReason();
  testTheCheckPressNeverClaimsAWrite();
  testTheAuditRowCarriesTheAttemptAsData();
  testAnUnnamedFileStillReadsAsEnglish();
}
