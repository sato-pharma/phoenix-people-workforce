import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  assertUndoAllowedAfterDownloads,
  BANK_FILE_DOWNLOADED_ACTION,
  DOWNLOAD_REFUSAL_OPENING,
  UNDO_AFTER_DOWNLOAD_MIN_REASON,
  listBankFileDownloads,
  recordBankFileDownloaded,
  type BankFileDownload,
} from "../src/lib/automated-payroll/bank-file-downloads.ts";
import { isUnchangedOutstationReapproval } from "../src/lib/outstation/expense-gate.ts";
import { mapOutstationRequestToPayrollExpenseRecord, outstationPayrollTripId } from "../src/lib/outstation/payroll-expense-mapping.ts";
import type { OutstationExpenseRequest } from "../src/lib/outstation/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A RUN WHOSE BANK FILES HAVE LEFT IS NOT QUIETLY CANCELLED, AND A SECOND APPROVE CHANGES NOTHING.
 *
 * F-PAY-016 — nothing recorded that finance had downloaded a FAB, CIB or finance file, so a run could
 * be cancelled after its money went to the bank and the month paid again by the next run. Every
 * download now writes a REQUIRED record first (no record, no file), and cancelling refuses while any
 * record exists unless an override says why.
 *
 * F-PAY-015 — approving an outstation claim that was already accepted re-ran the status write, the
 * push into payroll and the audit. An unchanged re-approve is now a no-op.
 *
 * REC-035 — reopening Part 2 or Part 1 after a download is refused exactly like cancel, with the same
 * override; and a second push of the same trip can never become a second payroll row.
 */

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `could not find the end of ${signature}`);
  return source.slice(start, end);
}

type Inserted = Record<string, unknown>;

function insertClient(result: { error: { message: string } | null }, inserted: Inserted[] = []) {
  return {
    from(table: string) {
      assert.equal(table, "automated_payroll_audit");
      return {
        insert(row: Inserted) {
          inserted.push(row);
          return Promise.resolve(result);
        },
      };
    },
  } as never;
}

function selectClient(result: { data: unknown[] | null; error: { message: string } | null }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve(result),
  };
  return { from: () => chain } as never;
}

const download = (at: string): BankFileDownload => ({
  file: "fab",
  scope: "part1",
  fileName: "FAB-Salary-Transfer-October-2026-part1.xlsx",
  actorHrId: "B-10",
  downloadedAt: at,
});

export async function runAutomatedPayrollBankFileDownloadGuardTests() {
  // ==== A download is recorded, or not handed out ================================================
  const inserted: Inserted[] = [];
  await recordBankFileDownloaded(
    { runId: "run-1", actorHrId: "B-10", file: "cib", scope: "part2", fileName: "CIB.xlsx" },
    insertClient({ error: null }, inserted),
  );
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].action, BANK_FILE_DOWNLOADED_ACTION);
  assert.deepEqual(inserted[0].detail, { file: "cib", scope: "part2", fileName: "CIB.xlsx" });

  await assert.rejects(
    recordBankFileDownloaded(
      { runId: "run-1", actorHrId: "B-10", file: "fab", scope: "part1", fileName: "FAB.xlsx" },
      insertClient({ error: { message: "forced write failure" } }),
    ),
    (error: Error) => /^Conflict:/.test(error.message) && /not handed out/.test(error.message),
    "HEADLINE: a download whose record cannot be written must throw, so the route hands out no file",
  );

  // ==== A read failure refuses the cancel — never an empty list ==================================
  await assert.rejects(
    listBankFileDownloads("run-1", selectClient({ data: null, error: { message: "forced read failure" } })),
    /not cancelled/,
    "a failed read of the download records must throw, not read as 'nothing downloaded'",
  );
  const listed = await listBankFileDownloads(
    "run-1",
    selectClient({
      data: [{ actor_hr_id: "B-10", detail: { file: "finance", scope: "full", fileName: "F.xlsx" }, created_at: "2026-11-13T10:00:00Z" }],
      error: null,
    }),
  );
  assert.deepEqual(listed, [
    { file: "finance", scope: "full", fileName: "F.xlsx", actorHrId: "B-10", downloadedAt: "2026-11-13T10:00:00Z" },
  ]);

  // ==== Cancel after a download: refused, unless an override says why ===========================
  assert.deepEqual(assertUndoAllowedAfterDownloads([]), { overridden: false, reason: null });
  assert.throws(
    () => assertUndoAllowedAfterDownloads([download("2026-11-13T10:00:00Z")]),
    (error: Error) => /^Conflict:/.test(error.message) && /FAB bank file \(part1\)/.test(error.message) && /12:00/.test(error.message),
    "HEADLINE: cancelling after a bank file was downloaded must be refused, naming the file and its Cairo time",
  );
  assert.throws(
    () => assertUndoAllowedAfterDownloads([download("2026-11-13T10:00:00Z")], { reason: "oops" }),
    /at least/,
    "an override needs a real reason",
  );
  const reason = "bank rejected the file, re-running the month";
  assert.ok(reason.length >= UNDO_AFTER_DOWNLOAD_MIN_REASON);
  assert.deepEqual(assertUndoAllowedAfterDownloads([download("2026-11-13T10:00:00Z")], { reason }), {
    overridden: true,
    reason,
  });

  // ==== REC-035: reopening Part 2 or Part 1 after a download, the same way =======================
  for (const [action, verb] of [["reopen_part2", "reopen Part 2"], ["reopen_part1", "reopen Part 1"]] as const) {
    assert.deepEqual(
      assertUndoAllowedAfterDownloads([], null, action),
      { overridden: false, reason: null },
      `${verb} with no download is unchanged`,
    );
    assert.throws(
      () => assertUndoAllowedAfterDownloads([download("2026-11-13T08:00:00Z"), download("2026-11-13T10:00:00Z")], null, action),
      (error: Error) =>
        error.message.startsWith(`Conflict: ${DOWNLOAD_REFUSAL_OPENING} 2 files for this run — FAB bank file (part1)`) &&
        /12:00 Cairo time/.test(error.message) &&
        error.message.includes(`To ${verb} anyway, send an override`),
      `HEADLINE: ${verb} after a bank file was downloaded is refused (409), naming the files and the latest Cairo time`,
    );
    assert.throws(
      () => assertUndoAllowedAfterDownloads([download("2026-11-13T10:00:00Z")], { reason: "  too short " }, action),
      /^Error: Conflict:.*at least 10 characters/,
      `${verb} with a short reason is refused`,
    );
    assert.throws(
      () => assertUndoAllowedAfterDownloads([download("2026-11-13T10:00:00Z")], { reason: null }, action),
      /^Error: Conflict:/,
      `${verb} with an override and no reason is refused`,
    );
    assert.deepEqual(
      assertUndoAllowedAfterDownloads([download("2026-11-13T10:00:00Z")], { reason: `  ${reason}  ` }, action),
      { overridden: true, reason },
      `${verb} with a real reason goes through, and the trimmed reason is returned for the audit row`,
    );
  }
  await assert.rejects(
    listBankFileDownloads("run-1", selectClient({ data: null, error: { message: "forced read failure" } })),
    /not cancelled, reopened or cleared/,
    "a failed read refuses a reopen too — the reopens call this same read, unguarded",
  );

  // ==== Wiring: every file records before it is returned; cancel checks before it writes =========
  const runService = stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8"));
  for (const [builder, file] of [
    ["buildFinanceSheet", "finance"],
    ["buildFabSheet", "fab"],
    ["buildCibSheet", "cib"],
  ] as const) {
    const body = bodyOf(runService, `export async function ${builder}(`);
    const recordAt = body.indexOf("await recordBankFileDownloaded(");
    assert.ok(recordAt > 0, `HEADLINE: ${builder} must record the download (${file})`);
    assert.match(body.slice(recordAt, recordAt + 200), new RegExp(`file: "${file}"`), `${builder} records itself as ${file}`);
    assert.ok(recordAt < body.lastIndexOf("return { buffer"), `${builder} must record BEFORE it returns the file`);
  }
  const cancel = bodyOf(runService, "export async function cancelRun(");
  const guardAt = cancel.indexOf('assertUndoAllowedAfterDownloads(await listBankFileDownloads(runId), options.overrideDownloaded, "cancel")');
  assert.ok(guardAt > cancel.indexOf("whileClaimed("), "HEADLINE: cancel checks the downloads under its claim");
  assert.ok(
    guardAt < cancel.indexOf("await releaseCarryForwardForCancelledRun(") && guardAt < cancel.indexOf('phase: "cancelled"'),
    "cancel refuses BEFORE it touches the ledger or the phase, so a refused cancel changes nothing",
  );
  assert.match(cancel, /overrideReason: override\.reason/, "an override's reason is kept on the cancel's audit row");

  const route = stripComments(readFileSync("app/api/automated-payroll/runs/[runId]/cancel/route.ts", "utf8"));
  assert.match(route, /body\?\.overrideDownloaded === true/, "the route only overrides on an explicit true");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the cancel route keeps its CSRF check");

  // ==== REC-035 wiring: both reopens check under their claim, before anything moves ===============
  const reopens = [
    {
      fn: "unconfirmPart2",
      action: "reopen_part2",
      writes: ["await releaseLateExpenseReservations(runId)", "await releaseCarryForwardForCancelledRun(", 'phase: "part2"'],
      routePath: "app/api/automated-payroll/runs/[runId]/part2/unconfirm/route.ts",
    },
    {
      fn: "unconfirmPart1",
      action: "reopen_part1",
      writes: ["await releaseLateExpenseReservations(runId)", "await upsertDraftRows(runId, patches)", "await recordHeldReleases(", 'phase: "part1"'],
      routePath: "app/api/automated-payroll/runs/[runId]/part1/unconfirm/route.ts",
    },
  ];
  for (const { fn, action, writes, routePath } of reopens) {
    const body = bodyOf(runService, `export async function ${fn}(`);
    const at = body.indexOf(`assertUndoAllowedAfterDownloads(await listBankFileDownloads(runId), options.overrideDownloaded, "${action}")`);
    assert.ok(at > 0, `HEADLINE: ${fn} reads the bank-file downloads and refuses after one (REC-035)`);
    assert.ok(at > body.indexOf("whileClaimed(runId, transition"), `${fn} checks under its claim`);
    for (const write of writes) {
      assert.ok(body.indexOf(write) > at, `HEADLINE: ${fn} refuses BEFORE ${write}, so a refused reopen changes nothing`);
    }
    assert.match(
      body,
      /reopenedAfterBankFileDownload: true, overrideReason: override\.reason/,
      `${fn}'s override and its reason are kept on its own audit row`,
    );
    const reopenRoute = stripComments(readFileSync(routePath, "utf8"));
    assert.ok(
      reopenRoute.includes(
        'body?.overrideDownloaded === true ? { reason: typeof body.reason === "string" ? body.reason : null } : null',
      ),
      `the ${fn} route passes an override only on an explicit true`,
    );
    assert.ok(reopenRoute.includes(`${fn}(access, runId, {`), `the ${fn} route hands the override to the service`);
    assert.match(reopenRoute, /assertSameOriginMutation\(request\)/, `the ${fn} route keeps its CSRF check`);
  }
  // Reopen Part 1 puts the carried trips back FIRST, as cancel and Reopen Part 2 do: a failed release then
  // refuses (whileClaimed lets the claim go) before any first instalment is unfrozen or held release withdrawn.
  {
    const part1 = bodyOf(runService, "export async function unconfirmPart1(");
    const releaseAt = part1.indexOf("await releaseLateExpenseReservations(runId)");
    for (const write of ["await upsertDraftRows(runId, patches)", "await recordHeldReleases(", "await updateRun("]) {
      assert.ok(releaseAt > 0 && releaseAt < part1.indexOf(write), `HEADLINE: Reopen Part 1 releases the carried trips before ${write}`);
    }
  }

  // ==== REC-035 page: both reopen buttons offer the override, matching the server's words ==========
  const wizard = stripComments(readFileSync("src/components/automated-payroll/automated-payroll-wizard.tsx", "utf8"));
  assert.ok(wizard.includes(`const DOWNLOAD_REFUSAL_OPENING = "${DOWNLOAD_REFUSAL_OPENING}";`), "the page matches the server's refusal words");
  assert.ok(wizard.includes(`const OVERRIDE_MIN_REASON = ${UNDO_AFTER_DOWNLOAD_MIN_REASON};`), "and its shortest reason");
  assert.equal((wizard.match(/overridable: true,/g) ?? []).length, 2, "HEADLINE: Reopen Part 1 and Reopen Part 2 both offer the override");
  assert.ok(wizard.includes("res.status === 409 && message.startsWith(DOWNLOAD_REFUSAL_OPENING)"), "only a download refusal opens the prompt");
  assert.ok(wizard.includes("overrideDownloaded: true, reason: override.reason"), "the prompt sends the override with its reason");
  assert.ok(wizard.includes("overrideReason.trim().length < OVERRIDE_MIN_REASON"), "the button waits for a real reason");

  // ==== F-PAY-015: an unchanged re-approve is a no-op ============================================
  const base = { currentStatus: "accepted_by_admin", acceptedStatus: "accepted_by_admin", typedComment: null };
  assert.equal(isUnchangedOutstationReapproval({ ...base, alreadyPushed: true, payrollEligible: true }), true,
    "HEADLINE: an accepted claim already in the payroll queue, approved again with no comment, changes nothing");
  assert.equal(isUnchangedOutstationReapproval({ ...base, alreadyPushed: false, payrollEligible: false }), true,
    "an accepted claim the evidence gate holds is released by the release path, not a second approve");
  assert.equal(isUnchangedOutstationReapproval({ ...base, alreadyPushed: false, payrollEligible: true }), false,
    "an accepted, eligible claim with no payroll row still runs, so the missing row is pushed");
  assert.equal(isUnchangedOutstationReapproval({ ...base, typedComment: "paid per policy", alreadyPushed: true, payrollEligible: true }), false,
    "a new comment is a change");
  assert.equal(isUnchangedOutstationReapproval({ ...base, currentStatus: "accepted_by_system", alreadyPushed: true, payrollEligible: true }), false,
    "an admin confirming a system acceptance is a change");
  assert.equal(isUnchangedOutstationReapproval({ ...base, currentStatus: "needs_review", alreadyPushed: false, payrollEligible: true }), false);

  const service = stripComments(readFileSync("src/lib/outstation/service.ts", "utf8"));
  const approve = bodyOf(service, "export async function approveOutstationRequestForPayroll(");
  const noopAt = approve.indexOf("isUnchangedOutstationReapproval(");
  assert.ok(noopAt > approve.indexOf("assertOutstationClaimUnchanged("), "the no-op still answers to the revision the reviewer saw");
  for (const write of [".update(", "await pushAcceptedOutstationExpenseToPayroll(", "await writeRequiredAuditLog("]) {
    assert.ok(noopAt > 0 && noopAt < approve.indexOf(write), `HEADLINE: the unchanged re-approve returns before ${write}`);
  }
  assert.match(approve.slice(noopAt, noopAt + 600), /alreadyApproved: true/, "and says it was already approved");
  assert.ok(
    approve.indexOf("isOutstationExpenseInPayroll(linkedPayroll)") > 0 &&
      approve.indexOf("isOutstationExpenseInPayroll(linkedPayroll)") < noopAt,
    "a claim already paid in a payroll batch is refused before anything else",
  );

  // ==== REC-035: a second push of the same trip is one row and one amount ========================
  // The push is keyed on the trip: its id is fixed by the claim, the write is an upsert on trip_id, and
  // the table holds trip_id UNIQUE (outstation_expenses_trip_id_key, read on production 2026-11-13). So a
  // second push overwrites the trip's one row with the same figures; it can never add a second.
  const claim = {
    id: 4521,
    employeeHrId: "B-12",
    allowanceAmount: 400,
    expectedTotalAmount: 400,
    fuelAmount: 0,
    ticketAmount: 0,
    tripStartDate: "2026-11-05T00:00:00.000Z",
  } as unknown as OutstationExpenseRequest;
  const firstPush = mapOutstationRequestToPayrollExpenseRecord(claim);
  const secondPush = mapOutstationRequestToPayrollExpenseRecord(claim, { reportId: "report-1" });
  assert.equal(firstPush.tripId, outstationPayrollTripId(4521));
  assert.equal(secondPush.tripId, firstPush.tripId, "HEADLINE: a second push carries the same trip id as the first");
  assert.equal(secondPush.total, firstPush.total, "and the same amount");
  assert.equal(secondPush.preserveExistingDecision, true, "and never overwrites HR's decision on the row");
  {
    // What the upsert on trip_id leaves behind, in rows and in pay.
    const table = new Map<string, { total: number }>();
    for (const pushed of [firstPush, secondPush]) table.set(String(pushed.tripId), { total: pushed.total });
    assert.equal(table.size, 1, "HEADLINE: two pushes of one trip leave one row");
    assert.equal([...table.values()].reduce((sum, row) => sum + row.total, 0), firstPush.total, "and one amount");
  }
  const expenses = stripComments(readFileSync("src/lib/outstation/expenses.ts", "utf8"));
  const save = bodyOf(expenses, "export async function savePayrollExpenseApprovals(");
  assert.match(
    save,
    /\.from\("outstation_expenses"\)\s*\.upsert\(payload\.slice\(start, start \+ UPSERT_CHUNK_SIZE\), \{ onConflict: "trip_id" \}\)/,
    "HEADLINE: the payroll write is an upsert keyed on trip_id",
  );
  assert.doesNotMatch(save, /\.from\("outstation_expenses"\)\s*\.insert\(/, "and never a plain insert of a trip row");
  const pushFn = bodyOf(service, "async function pushAcceptedOutstationExpenseToPayroll(");
  assert.match(pushFn, /if \(isOutstationExpenseInPayroll\(linkedPayroll\)\) \{\s*return 0;/, "a trip already paid is not pushed at all");
  assert.match(pushFn, /reportId: linkedPayroll\?\.reportId \?\? null/, "a re-push reuses the trip's report");
  const baseline = readFileSync("supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql", "utf8");
  assert.match(baseline, /ADD CONSTRAINT payroll_expenses_trip_id_key UNIQUE \(trip_id\);/, "HEADLINE: the table holds trip_id unique");
  const migrations = execFileSync("git", ["ls-files", "supabase/migrations"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const file of migrations) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /drop constraint[^;]*trip_id_key/i, `${file} must not drop the one-row-per-trip key`);
  }
}
