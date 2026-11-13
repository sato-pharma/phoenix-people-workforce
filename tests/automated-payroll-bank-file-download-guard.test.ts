import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertCancelAllowedAfterDownloads,
  BANK_FILE_DOWNLOADED_ACTION,
  CANCEL_AFTER_DOWNLOAD_MIN_REASON,
  listBankFileDownloads,
  recordBankFileDownloaded,
  type BankFileDownload,
} from "../src/lib/automated-payroll/bank-file-downloads.ts";
import { isUnchangedOutstationReapproval } from "../src/lib/outstation/expense-gate.ts";
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
  assert.deepEqual(assertCancelAllowedAfterDownloads([]), { overridden: false, reason: null });
  assert.throws(
    () => assertCancelAllowedAfterDownloads([download("2026-11-13T10:00:00Z")]),
    (error: Error) => /^Conflict:/.test(error.message) && /FAB bank file \(part1\)/.test(error.message) && /12:00/.test(error.message),
    "HEADLINE: cancelling after a bank file was downloaded must be refused, naming the file and its Cairo time",
  );
  assert.throws(
    () => assertCancelAllowedAfterDownloads([download("2026-11-13T10:00:00Z")], { reason: "oops" }),
    /at least/,
    "an override needs a real reason",
  );
  const reason = "bank rejected the file, re-running the month";
  assert.ok(reason.length >= CANCEL_AFTER_DOWNLOAD_MIN_REASON);
  assert.deepEqual(assertCancelAllowedAfterDownloads([download("2026-11-13T10:00:00Z")], { reason }), {
    overridden: true,
    reason,
  });

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
  const guardAt = cancel.indexOf("assertCancelAllowedAfterDownloads(await listBankFileDownloads(runId), options.overrideDownloaded)");
  assert.ok(guardAt > cancel.indexOf("whileClaimed("), "HEADLINE: cancel checks the downloads under its claim");
  assert.ok(
    guardAt < cancel.indexOf("await releaseCarryForwardForCancelledRun(") && guardAt < cancel.indexOf('phase: "cancelled"'),
    "cancel refuses BEFORE it touches the ledger or the phase, so a refused cancel changes nothing",
  );
  assert.match(cancel, /overrideReason: override\.reason/, "an override's reason is kept on the cancel's audit row");

  const route = stripComments(readFileSync("app/api/automated-payroll/runs/[runId]/cancel/route.ts", "utf8"));
  assert.match(route, /body\?\.overrideDownloaded === true/, "the route only overrides on an explicit true");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the cancel route keeps its CSRF check");

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
}
