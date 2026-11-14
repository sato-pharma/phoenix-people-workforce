import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  databaseErrorCode,
  databaseFailureNote,
  isPlainDatabaseError,
} from "../src/lib/automated-payroll/db-error.ts";
import { assertSettlementTarget, settlementCeiling } from "../src/lib/automated-payroll/held-settlements.ts";
import { jsonError } from "../src/lib/automated-payroll/http.ts";

/**
 * THE AUTOMATED PAYROLL AUDIT OF 14 NOVEMBER 2026, FINDINGS 6 TO 16 (owner: "build the remaining audit
 * findings 6 to 16").
 *
 * Each block names its finding. Where the rule is a pure function it is called; where it lives in a
 * service that needs a live database (exclude, include, save, import, start, publish) it is pinned on the
 * SOURCE, written against the call itself so that deleting or reordering it fails here — the same
 * approach as automated-payroll-recurring-non-employees.test.ts, for the same reason: a mocked client
 * would pin the mock. Finding 11's seeding rule is exercised for real in
 * automated-payroll-non-employee-seeding.test.ts, against the fake client.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const RUN_SERVICE = read("../src/lib/automated-payroll/run-service.ts");
const DRAFT_STORE = read("../src/lib/automated-payroll/draft-store.ts");
const HELD_SETTLEMENTS = read("../src/lib/automated-payroll/held-settlements.ts");
const PUBLISHED_HOLDS = read("../src/lib/automated-payroll/published-holds.ts");
const NON_EMPLOYEES = read("../src/lib/automated-payroll/non-employees.ts");
const RECURRING = read("../src/lib/automated-payroll/non-employee-recurring.ts");
const WIZARD = read("../src/components/automated-payroll/automated-payroll-wizard.tsx");
const PAID_OUTSIDE_PANEL = read("../src/components/automated-payroll/held-paid-outside-panel.tsx");

/** One exported function's body: from its declaration to the next top-level `export`. */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must exist`);
  const end = source.indexOf("\nexport ", start + declaration.length);
  return source.slice(start, end > start ? end : undefined);
}

export async function runAutomatedPayrollAuditFindings202611Tests() {
  // ---- FINDING 6: a publish that wrote the payslips but could not mark the run says so ----------------
  // It read as a bare "Failed to publish", so HR believed nothing had happened and could reopen or cancel
  // the run, releasing debts that month really collected.
  const markPublished = bodyOf(DRAFT_STORE, "export async function markRunPublished(");
  assert.match(markPublished, /"Conflict: the payslips for this run WERE written and are live/, "finding 6: the refusal must say the payslips are live, as a 409");
  assert.match(markPublished, /Press Publish again to finish\. Do NOT reopen or cancel this run/, "finding 6: and that the fix is to publish again, never to reopen or cancel");

  // ---- FINDINGS 7 AND 15: a refusal reaches HR as its own sentence, a database failure as its code ------
  const plain = { code: "23505", message: 'duplicate key value violates unique constraint "automated_payroll_runs_one_active"' };
  assert.equal(databaseFailureNote(plain, "test_event"), "database error 23505", "finding 15: the screen gets the code, not the table layout");
  assert.equal(databaseFailureNote(new Error("socket hang up"), "test_event"), "database error", "an error with no code is still not repeated word for word");
  assert.equal(
    databaseErrorCode(new Error("Conflict: could not record it. (database error PGRST116)")),
    "PGRST116",
    "a refusal this module already wrote carries its code through",
  );
  assert.ok(isPlainDatabaseError({ code: "22P02", message: "x" }), "a PostgREST error is a plain object");
  assert.ok(!isPlainDatabaseError(new Error("Conflict: x")), "an Error is not");
  assert.ok(!isPlainDatabaseError({ code: "not-a-code" }), "nor is any object with a code field");

  const badLink = jsonError({ code: "22P02", message: 'invalid input syntax for type uuid: "run-1"' }, "Failed to load the run.");
  assert.equal(badLink.status, 400, "finding 16: a link naming no real run is the caller's mistake, not a 500");
  const badLinkBody = (await badLink.json()) as { error: string };
  assert.match(badLinkBody.error, /does not exist/);
  assert.doesNotMatch(badLinkBody.error, /invalid input syntax/, "the database's own text never reaches the screen");

  const otherDb = jsonError({ code: "42P01", message: 'relation "automated_payroll_internal" does not exist' }, "Failed to load the run.");
  assert.equal(otherDb.status, 500, "finding 7: a plain database error is no longer read as \"[object Object]\"");
  assert.equal(((await otherDb.json()) as { error: string }).error, "Failed to load the run. (database error 42P01)");

  const conflict = jsonError(new Error("Conflict: Part 2 is confirmed."), "Failed.");
  assert.equal(conflict.status, 409, "a Conflict: refusal answers 409 with its sentence");
  assert.equal(((await conflict.json()) as { error: string }).error, "Part 2 is confirmed.");

  // The refusals the audit found reaching HR as "request failed" now carry the prefix.
  assert.match(PUBLISHED_HOLDS + HELD_SETTLEMENTS, /`Conflict: Held salary cannot be shown: the payroll for/, "finding 7: the held-record refusal on every confirm and publish");
  assert.match(DRAFT_STORE, /"Conflict: Part 1 could not be reopened, so nothing was changed/, "finding 7: the Reopen Part 1 failure");
  assert.match(RUN_SERVICE, /"Conflict: Could not read what this run confirmed at Part 2/, "finding 7: the Part 2 stamp read on publish");

  // ---- FINDING 8: who the run pays is fixed once Part 2 is confirmed, and only real people move ---------
  assert.match(
    RUN_SERVICE,
    /function assertPopulationOpen\(run: MonthlySalaryRun, verb: string\): void \{\s*if \(run\.phase === "ready"\) \{\s*throw new Error\(\s*`Conflict: Part 2 is confirmed/,
    "finding 8: an exclusion after Part 2 moved the totals off the stamp, so publish and the bank files refused",
  );
  const exclude = bodyOf(RUN_SERVICE, "export async function excludeEmployeeFromRun(");
  const include = bodyOf(RUN_SERVICE, "export async function includeEmployeeInRun(");
  for (const [name, body] of [["exclude", exclude], ["include", include]] as const) {
    const guardAt = body.indexOf("assertPopulationOpen(run,");
    const writeAt = body.indexOf("holdRun(");
    assert.ok(guardAt > 0 && writeAt > guardAt, `finding 8: ${name} must refuse a confirmed Part 2 before it writes`);
  }
  assert.match(
    exclude,
    /if \(!draft\?\.excluded && !members\.some\(\(member\) => member\.compact === compact\)\) \{\s*throw new Error\("Validation: that person is not on this month's payroll/,
    "finding 8: an HR id from nowhere must not leave a draft row behind",
  );
  assert.match(include, /if \(!draft\?\.excluded\) throw new Error\("Validation: that person is not excluded from this run\."\)/, "finding 8: only an exclusion can be undone");

  // ---- FINDING 9: a by-hand transfer is checked against what that month really owes ---------------------
  assert.equal(settlementCeiling({ outstanding: 1000, settled: null }), 1000, "nothing recorded yet: the ceiling is what is owed");
  assert.equal(
    settlementCeiling({ outstanding: 750, settled: { amount: 250 } as never }),
    1000,
    "a correction may restate the earlier record, so it adds back",
  );
  assert.equal(settlementCeiling({ outstanding: 0.1 + 0.2, settled: null }), 0.3, "rounded to the piastre");
  await assert.rejects(
    assertSettlementTarget("run-1", "b10", 100),
    /^Error: Not found: that payroll month does not exist\.$/,
    "finding 9: a run id that is not a uuid is refused before any read",
  );
  const record = bodyOf(HELD_SETTLEMENTS, "export async function recordHeldSettlement(");
  const recordGuard = record.indexOf("await assertSettlementTarget(runId, compact,");
  assert.ok(recordGuard > 0 && recordGuard < record.indexOf(".upsert("), "finding 9: the target and the amount are checked before the write");
  assert.match(record, /assertRealSessionForDecision\(access, "record held salary as paid outside payroll"\)/, "a preview session records nothing");
  assert.match(HELD_SETTLEMENTS, /if \(input\.paidOn > cairoToday\(\)\) \{\s*throw new Error\("Validation: the transfer date is in the future/, "a transfer is recorded once it is made");
  const remove = bodyOf(HELD_SETTLEMENTS, "export async function deleteHeldSettlement(");
  assert.match(remove, /assertRealSessionForDecision\(access, "withdraw a held salary transfer recorded outside payroll"\)/);
  assert.match(remove, /if \(!isUuid\(runId\)\) throw new Error\("Not found: that payroll month does not exist\."\)/);
  // ...and the server had recorded it since September with no screen; the panel is on both held steps.
  assert.match(
    WIZARD,
    /activeStep === "p1_held_release" \|\| activeStep === "p2_held_release" \? \(\s*<HeldPaidOutsidePanel/,
    "finding 9: the Paid outside payroll panel sits on both Held Salary Release steps",
  );
  assert.match(
    PAID_OUTSIDE_PANEL,
    /fetch\(`\/api\/automated-payroll\/runs\/\$\{chosen\.runId\}\/held-settlements`, \{\s*method: "POST"/,
    "the transfer is recorded against the HELD month, not the run on screen",
  );
  assert.match(
    PAID_OUTSIDE_PANEL,
    /const ceilingOf = \(balance: HeldBalance\) => Math\.round\(\(balance\.outstanding \+ \(balance\.settled\?\.amount \?\? 0\)\) \* 100\) \/ 100;/,
    "the panel's limit mirrors settlementCeiling",
  );
  // A closed native select cannot wrap: at 375px "Choose the person and the month held" was cut mid-word
  // (owner, 14 Nov 2026). The placeholder fits, and on a phone the full choice is repeated below, wrapped.
  assert.match(PAID_OUTSIDE_PANEL, /<option value="">Choose a person<\/option>/, "the picker's placeholder fits a phone");
  assert.match(
    PAID_OUTSIDE_PANEL,
    /hint=\{chosen \? <span className="md:hidden">\{choiceLabel\(chosen\)\}<\/span> : undefined\}/,
    "on a phone the chosen person, month and amount show in full under the picker",
  );

  // ---- FINDING 10: a step goes back to pending BEFORE its figures are written ---------------------------
  const save = bodyOf(RUN_SERVICE, "export async function saveStep(");
  const pendingAt = save.indexOf('upsertStepState({ runId, stepKey, status: "pending", inputMode })');
  const rowsAt = save.indexOf("await upsertDraftRows(runId, patches)");
  assert.ok(pendingAt > 0 && rowsAt > pendingAt, "finding 10: a write that fails part-way must not leave a confirmed badge over it");

  // ---- FINDING 12: a changed non-employee entry is audited like add and remove ---------------------------
  const update = bodyOf(NON_EMPLOYEES, "export async function updateNonEmployeePayrollEntry(");
  assert.match(update, /action: "non_employee_updated"/, "finding 12: a changed salary or account must leave an audit row");
  assert.match(update, /"totalSalary", "bankName", "bankAccount"/, "and the money and bank fields are among those compared");

  // ---- FINDING 11: the standing list takes the per-run bank rule ----------------------------------------
  assert.match(RECURRING, /function validateInput\(input: RecurringNonEmployeeInput\): void \{\s*validateNonEmployeePayrollInput\(input\);/, "finding 11: one rule for both lists");

  // ---- FINDING 13: an imported sheet commits exactly what its preview accepted ---------------------------
  const importer = bodyOf(RUN_SERVICE, "export async function importStepUpload(");
  assert.match(importer, /const accepted = edits\.filter\(\(edit\) => known\.has\(String\(edit\.hrId \?\? ""\)\.toLowerCase\(\)\)\);/, "finding 13: rows the preview called invalid are not written");
  assert.match(importer, /await saveStep\(access, runId, stepKey, accepted, "xlsx"/, "and only the accepted rows are saved");
  assert.match(importer, /applied: accepted\.length/, "and the count says what was applied, not what was in the file");

  // ---- FINDING 14: a run can be cancelled from the screen -------------------------------------------------
  assert.match(WIZARD, /url: `\/api\/automated-payroll\/runs\/\$\{run\.id\}\/cancel`/, "finding 14: the Cancel run button calls the cancel route");
  const cancelAt = WIZARD.indexOf("/cancel`");
  assert.match(
    WIZARD.slice(cancelAt, cancelAt + 400),
    /overridable: true,\s*reasonLabel: "Why cancel anyway",\s*dismissLabel: "Keep the run"/,
    "behind the same bank-file override as a reopen, with labels that read right on a cancel",
  );

  // ---- FINDING 16: Start says what is wrong, and a double press resumes ---------------------------------
  const start = bodyOf(RUN_SERVICE, "export async function startOrResumeRun(");
  assert.match(start, /throw new Error\("Validation: the month must be from 1 to 12\."\)/);
  assert.match(start, /throw new Error\("Validation: the year must be from 2000 to 2100\."\)/);
  assert.match(
    start,
    /\?\.code === "23505"\s*\?\s*await findActiveRun\(period\.month, period\.year\)/,
    "finding 16: a second press refused by the one-active-run index returns the run the first press started",
  );
}
