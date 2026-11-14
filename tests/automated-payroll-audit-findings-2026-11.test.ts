import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  databaseErrorCode,
  databaseFailureNote,
  isPlainDatabaseError,
} from "../src/lib/automated-payroll/db-error.ts";
import { isRunHoldAction, RUN_HOLD_ACTIONS } from "../src/lib/automated-payroll/transition-claim.ts";
import { assertSettlementTarget, settlementCeiling } from "../src/lib/automated-payroll/held-settlements.ts";
import { jsonError } from "../src/lib/automated-payroll/http.ts";
import {
  assertPart2FileMatchesStamp,
  compareNonEmployees,
  PART2_NON_EMPLOYEES_KEY,
  part2NonEmployees,
  readConfirmedNonEmployees,
} from "../src/lib/automated-payroll/publish-guard.ts";

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
const RECOMMENDATION_STEP = read("../src/components/automated-payroll/recommendation-step.tsx");
const LATE_EXPENSES_PANEL = read("../src/components/automated-payroll/late-expenses-panel.tsx");
const STANDING_LIST_PANEL = read("../src/components/automated-payroll/recurring-non-employees-panel.tsx");

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
  // At 375px the Confirmed badge shared a row that could not wrap with the two Excel buttons and was
  // squeezed to "Co" (owner, 14 Nov 2026): the row wraps, and the badge never shrinks.
  assert.match(
    RECOMMENDATION_STEP,
    /<div className="flex flex-wrap items-center gap-2">\s*\{confirmed \? \(\s*<Badge variant="success" className="shrink-0 gap-1">/,
    "the Confirmed badge and the Excel buttons wrap on a phone instead of cutting the badge",
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

  // ---- S1: every non-employee write holds the run, like a step save ---------------------------------------
  // The phase was read once before the write, so an add racing Confirm Part 2 landed after the stamp and
  // the bank file carried an amount nobody confirmed.
  assert.match(
    NON_EMPLOYEES,
    /holdRun\(\{ runId, expected: \[EDITABLE_PHASE\[part\]\], action: RUN_HOLD_ACTIONS\.nonEmployee \}, async \(\) => \{\s*await requireEditableRun\(runId, part\);\s*return work\(\);/,
    "S1: the hold re-checks the part is still open before the write",
  );
  for (const declaration of [
    "export async function addNonEmployeePayrollEntry(",
    "export async function updateNonEmployeePayrollEntry(",
    "export async function deleteNonEmployeePayrollEntry(",
  ]) {
    const body = bodyOf(NON_EMPLOYEES, declaration);
    const heldAt = body.indexOf("holdForPart(runId,");
    const writeAt = body.search(/getSupabaseAdmin\(\)\.from\(TABLE\)\.(insert|update|delete)\(/);
    assert.ok(heldAt > 0 && writeAt > heldAt, `S1: ${declaration} writes only inside the run's hold`);
  }
  assert.match(
    bodyOf(RECURRING, "export async function syncRunFromRecurring("),
    /holdRun\(\{ runId, expected: \[phase\], action: RUN_HOLD_ACTIONS\.nonEmployeeSync \}, \(\) =>\s*seedRunFromRecurring\(/,
    "S1: pulling in the standing list holds the run too",
  );
  assert.equal(isRunHoldAction(RUN_HOLD_ACTIONS.nonEmployee), true, "S1: a transition waits a non-employee write out");
  assert.equal(isRunHoldAction(RUN_HOLD_ACTIONS.nonEmployeeSync), true, "S1: and the sync");

  // ---- S2: the two reads that could pass PostgREST's 1,000-row cap are paged -----------------------------
  assert.match(
    RUN_SERVICE,
    /fetchAllRows<\{ employee_hr_id: string \| null \}>\(\s*\(\) => getSupabaseAdmin\(\)\.from\("employee_resignations"\)/,
    "S2: every leaver is read, so none past the cap reads as 'disappeared'",
  );
  assert.match(
    HELD_SETTLEMENTS,
    /async function loadHeldEntryEmployees\(\)[\s\S]{0,400}?fetchAllRows<Row>\(\s*\(\) =>\s*getSupabaseAdmin\(\)\s*\.from\("employees"\)/,
    "S2: every employee is in the held-entry picker",
  );

  // ---- Confirm Part 2 holds the non-employees it pays (owner, "Close that gap") ----------------------------
  // The stamp was built from employee rows only, while the Part 2 FAB and CIB files also carry every Part 2
  // non-employee entry read live — so an entry changed after the confirm's read went to the bank unconfirmed.
  const entry = (over: Partial<{ id: string; part: string; fullNameEn: string; totalSalary: number; bankName: string | null; bankAccount: string | null }> = {}) => ({
    id: "ne-1",
    part: "second",
    fullNameEn: "Mona Adel",
    totalSalary: 5000,
    bankName: "CIB",
    bankAccount: "100200300",
    ...over,
  });
  const confirmed = part2NonEmployees("run-1", [entry(), entry({ id: "ne-2", part: "first", totalSalary: 900 })]);
  assert.deepEqual(Object.keys(confirmed), ["ne-1"], "only the entries paid with the second instalment are stamped");
  assert.ok(!JSON.stringify(confirmed).includes("100200300"), "the stamp holds a fingerprint, never the account number");
  assert.deepEqual(compareNonEmployees(confirmed, part2NonEmployees("run-1", [entry()])), [], "the same entry matches");
  for (const [what, moved] of [
    ["the amount", entry({ totalSalary: 5000.5 })],
    ["the account", entry({ bankAccount: "100200301" })],
    ["the bank", entry({ bankName: "FAB" })],
    ["the name", entry({ fullNameEn: "Mona Adel Hassan" })],
  ] as const) {
    assert.deepEqual(compareNonEmployees(confirmed, part2NonEmployees("run-1", [moved])), ["ne-1"], `a change to ${what} is caught`);
  }
  assert.deepEqual(
    compareNonEmployees(confirmed, part2NonEmployees("run-1", [entry(), entry({ id: "ne-3" })])),
    ["ne-3"],
    "an entry added after the confirm is caught",
  );
  assert.deepEqual(compareNonEmployees(confirmed, {}), ["ne-1"], "an entry removed after the confirm is caught");
  assert.deepEqual(readConfirmedNonEmployees({ [PART2_NON_EMPLOYEES_KEY]: confirmed }), confirmed, "the stamp reads back");
  assert.equal(readConfirmedNonEmployees({ confirmedTotals: {} }), null, "a stamp from before this carries none");

  const totals = { employees: 1, firstPart: 1, secondPart: 1, monthSalary: 2, net: 2 };
  const readyRun = { phase: "ready", part2ConfirmedAt: "2026-11-14T10:00:00Z" };
  const fileCheck = (stamp: Record<string, string> | null, current: Record<string, string>, run = readyRun) => () =>
    assertPart2FileMatchesStamp(run, totals, totals, undefined, {
      confirmed: stamp,
      current,
      nameOf: (id) => (id === "ne-1" ? "Mona Adel" : "an entry no longer on Non-Employees Payroll"),
    });
  assert.doesNotThrow(fileCheck(confirmed, confirmed), "an unchanged month downloads");
  assert.throws(
    fileCheck(confirmed, part2NonEmployees("run-1", [entry({ totalSalary: 7000 })])),
    /Conflict: The Part 2 non-employee entry for Mona Adel has changed since Part 2 was confirmed\. .*No file was produced/,
    "a Part 2 bank file refuses an entry that moved, naming it",
  );
  assert.doesNotThrow(fileCheck(null, {}), "a stamp written before this keeps today's behaviour");
  assert.doesNotThrow(
    fileCheck(confirmed, {}, { phase: "published", part2ConfirmedAt: readyRun.part2ConfirmedAt }),
    "a published month is a record, never held to the stamp",
  );

  const confirmPart2 = bodyOf(RUN_SERVICE, "export async function confirmPart2(");
  const firstRead = confirmPart2.indexOf(
    'const confirmedNonEmployees = part2NonEmployees(runId, await getNonEmployeePayrollRows(runId, "second"));',
  );
  const claimAt = confirmPart2.indexOf('await claimTransition(runId, ["part2"], "Confirming Part 2")');
  assert.ok(firstRead > 0 && claimAt > firstRead, "Confirm Part 2 reads the Part 2 non-employees before its claim");
  assert.match(
    confirmPart2.slice(claimAt),
    /compareNonEmployees\(\s*confirmedNonEmployees,\s*part2NonEmployees\(runId, await getNonEmployeePayrollRows\(runId, "second"\)\),\s*\)/,
    "and re-reads them under the claim",
  );
  assert.match(confirmPart2, /nonEmployeesMovedWhileConfirming\.length > 0\s*\)\s*\{\s*throw new Error\(/, "a difference refuses the confirm");
  assert.equal(
    confirmPart2.match(/\[PART2_NON_EMPLOYEES_KEY\]: confirmedNonEmployees,/g)?.length,
    2,
    "both the stamp row and the part2_confirmed row carry the fingerprints (the newest of the two is read)",
  );
  assert.match(
    RUN_SERVICE,
    /nonEmployees: readConfirmedNonEmployees\(newest\.detail\),/,
    "the stamp reader returns them",
  );
  const fileGuard = bodyOf(RUN_SERVICE, "async function assertFileMatchesPart2Confirm(");
  assert.match(
    fileGuard,
    /confirmed: stamp\.nonEmployees,\s*current: part2NonEmployees\(run\.id, nonEmployees\),/,
    "the Part 2 file check compares the live entries with the stamp",
  );
  assert.equal(
    RUN_SERVICE.match(/await assertFileMatchesPart2Confirm\(run, rows, draftRows, (allNonEmployees|nonEmployees)\);/g)?.length,
    3,
    "the full finance sheet, the Part 2 FAB file and the Part 2 CIB file all pass in the entries they carry",
  );

  // ---- Confirm Part 1 and Confirm Part 2 ask first (owner: "build the confirm prompts") ---------------------
  // One click froze real money and told finance to pay it. Both buttons now open the page's own in-page
  // prompt (the one publish, reopen and cancel already use), which then runs the confirm with its gates.
  for (const part of ["1", "2"] as const) {
    const handler = part === "1" ? "confirmPart1WithDataGate" : "confirmPart2WithOverpaidGate";
    assert.ok(
      !WIZARD.includes(`onClick={() => void ${handler}(run.id)}`),
      `Confirm Part ${part}: the button no longer confirms on the first click`,
    );
    assert.match(
      WIZARD,
      new RegExp(
        `setPendingAction\\(\\{\\s*title: \`Confirm Part ${part} for \\$\\{periodLabel\\}\\?\`,[\\s\\S]{0,600}?` +
          `label: "Confirm Part ${part}",[\\s\\S]{0,300}?onConfirm: \\(\\) => ${handler}\\(run\\.id\\),\\s*\\}\\)`,
      ),
      `Confirm Part ${part}: the button opens the prompt, and the prompt runs the confirm with its gates`,
    );
  }
  assert.match(
    WIZARD,
    /setPendingAction\(null\);\s*if \(action\.onConfirm\) void action\.onConfirm\(\);\s*else if \(action\.overridable\) void postReopen\(action\);/,
    "the prompt's own button runs the confirm, never a plain post that would skip the acknowledgement gates",
  );

  // ---- The late-expenses switch asks first (owner: "build the confirm prompt before the late-expenses switch") ----
  // Either way it clears every open run's saved Expenses figures and reopens that step, and ON adds money to
  // the run — on one tap. The switch now only opens a prompt; the prompt's button makes the change.
  assert.ok(
    !/onChange=\{\(checked\) => void flip\(checked\)\}/.test(LATE_EXPENSES_PANEL),
    "the late-expenses switch no longer changes the setting on the first tap",
  );
  assert.match(
    LATE_EXPENSES_PANEL,
    /onChange=\{\(checked\) => \{\s*if \(busy \|\| stepDirty\) return;\s*setPendingSwitch\(checked\);\s*\}\}/,
    "the switch opens the prompt instead",
  );
  assert.match(
    LATE_EXPENSES_PANEL,
    /const next = pendingSwitch;\s*setPendingSwitch\(null\);\s*void flip\(next\);/,
    "the prompt's own button makes the change",
  );
  assert.match(
    LATE_EXPENSES_PANEL,
    /The saved Expenses figures of every open run are cleared and its Expenses step reopens/,
    "the prompt says what the change clears",
  );

  // ---- The standing-list delete asks first (owner: "build the confirm prompt before the standing-list delete") ----
  // One tap on the bin removed a person from every future month, with no undo. Both bins (the desktop row and
  // the phone card) now only open a prompt; the prompt's button deletes.
  assert.ok(
    !/onClick=\{\(\) => void deleteExisting\(row\.id\)\}/.test(STANDING_LIST_PANEL),
    "no bin deletes a standing entry on the first tap",
  );
  assert.equal(
    (STANDING_LIST_PANEL.match(/onClick=\{\(\) => setPendingDeleteId\(row\.id\)\}/g) ?? []).length,
    2,
    "both bins, the desktop row's and the phone card's, open the prompt",
  );
  assert.match(
    STANDING_LIST_PANEL,
    /setPendingDeleteId\(null\);\s*void deleteExisting\(row\.id\);/,
    "the prompt's own button deletes",
  );
  assert.match(
    STANDING_LIST_PANEL,
    /This cannot be undone: to bring them back they have to be typed in again\./,
    "the prompt says the delete cannot be undone",
  );
}
