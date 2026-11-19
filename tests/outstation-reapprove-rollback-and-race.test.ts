import assert from "node:assert/strict";

import { AuditPersistenceError } from "../src/lib/admin/audit.ts";
import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  OUTSTATION_CLAIM_CHANGED_CODE,
  isOutstationClaimChangedError,
  outstationClaimRevision,
} from "../src/lib/outstation/claim-revision.ts";
import { approveOutstationRequestForPayroll } from "../src/lib/outstation/service.ts";
import { snapshot, withStandIn, writesTo, type Seen, type Tables } from "./support/postgrest-transaction-stand-in.ts";

// BEHAVIOUR TESTS FOR APPROVING AN OUTSTATION EXPENSE CLAIM INTO PAYROLL (F-PAY-015, PR #315).
//
// approveOutstationRequestForPayroll writes in three steps: a conditional status update pinned to the
// claim's stored `updated_at` (`.eq("updated_at", checkedUpdatedAt)`), then the push into payroll
// (a report row and the trip's `outstation_expenses` row), then the required audit rows.
// tests/automated-payroll-bank-file-download-guard.test.ts and tests/outstation-stale-approval.test.ts
// pin that by reading the source; this file runs the REAL function against the shared in-memory
// PostgREST (tests/support/postgrest-transaction-stand-in.ts) — no network, no environment file, no real database,
// nobody notified — and checks what it DOES:
//
//   (a) A FAILURE AFTER THE STATUS UPDATE. The payroll push, or the required audit, is made to fail
//       after the claim's status was written. The approver must be refused (never told "approved"),
//       no audit row may claim the trip reached payroll when it did not, nobody is notified, a failed
//       audit is queued rather than lost, and approving again after a reload pays the trip once.
//       NOTE: this operation is NOT all-or-nothing today — the status write (and the report row)
//       survive a failed push. That assertion is deliberately NOT in the exported run function; the
//       finding and that assertion are in docs/money-integrity-close-out-2026-11.md (§5 and the appendix).
//   (b) TWO APPROVALS AT ONCE. Two Super Admins approve the same claim, from the same screen version,
//       at the same moment. Exactly one applies; the other is refused as "the claim changed"
//       (OutstationClaimChangedError, a 409 at the routes) and writes nothing; the payroll row is
//       written once. A later approve of the now-accepted, unchanged claim changes nothing (F-PAY-015).

const CLAIM_ID = 4521;
const TRIP_ID = `OUTSTATION-${CLAIM_ID}`;
const STORED_AT = "2026-11-17T09:30:00.123456+00:00";
const SCREEN_REVISION = outstationClaimRevision(STORED_AT);
const DB_TIMEOUT = { body: { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" }, status: 500 };

const admin = (hrId: "B-10" | "B-11") =>
  createAccessContext({ hrId, loginId: `admin.${hrId.toLowerCase()}`, role: "Super Admin", source: "session" });

/** Lets any detached follow-up (the audit outbox's opportunistic drain) finish inside the stand-in. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The stored state; a table a read created empty is the same fact as an absent one. */
function stored(tables: Tables): Tables {
  return Object.fromEntries(Object.entries(snapshot(tables)).filter(([, rows]) => rows.length > 0));
}

const tableWrites = (seen: Seen[]) =>
  seen.filter((request) => request.rpc === null && request.method !== "GET" && request.method !== "HEAD");
const notificationWrites = (seen: Seen[]) => tableWrites(seen).filter((request) => /notification|telegram|whatsapp|email/i.test(request.table ?? ""));
const addedToPayrollAudits = (tables: Tables) =>
  (tables.audit_logs ?? []).filter((row) => /accepted \(accepted_by_admin\) and added to payroll/.test(String(row.summary)));

/** A fetch layer over the stand-in that gives every row inserted into `table` an id, as its default does. */
function generateIds(table: string, prefix: string): void {
  const inner = globalThis.fetch;
  let serial = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && url.pathname === `/rest/v1/${table}` && typeof init?.body === "string") {
      const parsed = JSON.parse(init.body) as Record<string, unknown> | Record<string, unknown>[];
      const withId = (row: Record<string, unknown>) => (row.id == null ? { id: `${prefix}-${(serial += 1)}`, ...row } : row);
      init = { ...init, body: JSON.stringify(Array.isArray(parsed) ? parsed.map(withId) : withId(parsed)) };
    }
    return inner(input, init);
  }) as typeof fetch;
}

/**
 * Holds every request `matches` picks until `parties` of them have arrived (or a second has passed),
 * then lets them through together: two approvals whose writes reach the database at the same moment,
 * after both have read the claim.
 */
function releaseTogether(matches: (url: URL, method: string) => boolean, parties: number): void {
  const inner = globalThis.fetch;
  const waiting: Array<() => void> = [];
  let arrived = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const openGate = () => {
    if (timer) clearTimeout(timer);
    while (waiting.length > 0) waiting.shift()?.();
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (matches(url, String(init?.method ?? "GET").toUpperCase()) && arrived < parties) {
      arrived += 1;
      if (arrived === parties) openGate();
      else {
        timer ??= setTimeout(openGate, 1000);
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    }
    return inner(input, init);
  }) as typeof fetch;
}

/** A 520.00 car trip on 5 Nov by Mona Adel Hassan (B-200), waiting for HR, with no evidence gate to hold it. */
function outstationTables(status: string): Tables {
  const workflowStatuses = ["draft", "pending", "needs_review", "approved", "rejected", "added_to_payroll"];
  return {
    audit_log_outbox: [],
    audit_logs: [],
    automated_payroll_runs: [],
    employees: [{ employment_status: "active", full_name: "Mona Adel Hassan", hr_id: "B-200", is_active: true, job_title: "Medical Representative" }],
    outstation_expense_reports: [],
    outstation_expense_requests: [
      {
        allowance_amount: 400,
        approval_reason: "Waiting for review.",
        calculation_status: status,
        created_at: "2026-11-05T18:00:00+00:00",
        employee_hr_id: "B-200",
        employee_name: "Mona Adel Hassan",
        employee_role: "Medical Representative",
        evidence_gate_status: "grandfathered",
        expected_total_amount: 520,
        expense_type: "traveling",
        fuel_amount: 120,
        id: CLAIM_ID,
        status,
        ticket_amount: 0,
        total_amount: 520,
        transportation_type: "car",
        trip_end_date: "2026-11-05",
        trip_start_date: "2026-11-05",
        updated_at: STORED_AT,
        workload_gate_status: "grandfathered",
      },
    ],
    outstation_expenses: [],
    workflow_registry_modules: [
      {
        actions: [{ allowedRoles: ["Super Admin"], auditLog: "approve", from: ["pending", "needs_review"], key: "approve", label: "Approve", to: "approved" }],
        created_at: "2026-01-01T00:00:00+00:00",
        created_by: "system",
        description: null,
        id: "wf-outstation-expenses",
        is_active: true,
        module_key: "outstation_expenses",
        module_name: "Outstation expenses",
        statuses: workflowStatuses.map((key) => ({ key, label: key })),
        updated_at: "2026-01-01T00:00:00+00:00",
        updated_by: "system",
        version: 1,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────── (a) a failure after the status update

async function approveRefusedWhenThePayrollPushFails(): Promise<void> {
  const tables = outstationTables("needs_review");
  await withStandIn({ failWrites: { outstation_expenses: DB_TIMEOUT }, tables }, async (seen) => {
    generateIds("outstation_expense_reports", "report");
    let refusal: unknown = null;
    let answer: unknown = null;
    try {
      answer = await approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), { expectedRevision: SCREEN_REVISION });
    } catch (error) {
      refusal = error;
    }
    await settle();
    assert.equal(answer, null, "(a) push: an approval whose payroll push failed must not hand back an approved claim");
    // The push rethrows the database's own error object (savePayrollExpenseApprovals: `if (error) throw error`).
    assert.notEqual(refusal, null, "(a) push: the approver is refused when the payroll push fails after the status update");
    assert.equal(
      (refusal as { message?: string }).message,
      "canceling statement due to statement timeout",
      "(a) push: the refusal carries the database's own reason",
    );
    assert.ok(!isOutstationClaimChangedError(refusal), "(a) push: a failed push is not dressed up as \"the claim changed\"");
    assert.equal(writesTo(seen, "outstation_expense_requests").length, 1, "(a) push: the forced failure came AFTER the status update (the first write)");
    assert.equal(writesTo(seen, "outstation_expenses").length, 1, "(a) push: the failure is the payroll row's own write");
    assert.deepEqual(tables.outstation_expenses, [], "(a) push: no payroll row exists for the trip — nothing will be paid from this attempt");
    assert.equal(writesTo(seen, "audit_logs").length, 0, "(a) push: no audit row says the claim was accepted and pushed to payroll when it was not");
    assert.deepEqual(notificationWrites(seen), [], "(a) push: nobody is notified of an approval that failed");
  });

  // After a reload the approver presses Approve again on what the screen now shows: the trip reaches
  // payroll exactly once.
  await withStandIn({ tables }, async (seen) => {
    generateIds("outstation_expense_reports", "report-retry");
    const revision = outstationClaimRevision(tables.outstation_expense_requests[0].updated_at);
    const retried = await approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), { expectedRevision: revision });
    await settle();
    assert.equal(retried.alreadyApproved, false, "(a) push: approving again after the failure runs the accept, so the missing payroll row is pushed");
    assert.equal(retried.request.status, "accepted_by_admin", "(a) push: and the claim reads accepted");
    assert.deepEqual(
      tables.outstation_expenses.map((row) => [row.trip_id, row.total, row.hr_approved]),
      [[TRIP_ID, 520, true]],
      "(a) push: the retry leaves exactly one payroll row for the trip, for the claimed 520.00",
    );
    assert.equal(writesTo(seen, "outstation_expenses").length, 1, "(a) push: the retry writes the payroll row once");
    assert.equal(addedToPayrollAudits(tables).length, 1, "(a) push: one \"accepted and added to payroll\" audit row, from the attempt that did it");
  });
}

async function approveRefusedWhenTheAuditFails(): Promise<void> {
  const tables = outstationTables("needs_review");
  await withStandIn({ failWrites: { audit_logs: DB_TIMEOUT }, tables }, async (seen) => {
    generateIds("outstation_expense_reports", "report");
    generateIds("audit_log_outbox", "outbox");
    let refusal: unknown = null;
    let answer: unknown = null;
    try {
      answer = await approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), { expectedRevision: SCREEN_REVISION });
    } catch (error) {
      refusal = error;
    }
    await settle();
    assert.equal(answer, null, "(a) audit: an approval whose required audit could not be written must not answer \"approved\"");
    assert.ok(refusal instanceof AuditPersistenceError, "(a) audit: the approver is refused with the required-audit error, which says to review the state before retrying");
    assert.equal(writesTo(seen, "outstation_expense_requests").length, 1, "(a) audit: the forced failure came AFTER the status update (the first write)");
    assert.deepEqual(
      (tables.audit_log_outbox ?? []).map((row) => (row.payload as { input?: { summary?: string } }).input?.summary),
      [`Outstation request ${CLAIM_ID} accepted; expense pushed to payroll.`],
      "(a) audit: the audit row that could not be written is queued in the outbox, never lost",
    );
    assert.equal(addedToPayrollAudits(tables).length, 0, "(a) audit: the final \"accepted and added to payroll\" row is never written after the refusal");
    assert.deepEqual(notificationWrites(seen), [], "(a) audit: nobody is notified of an approval that was refused");
  });
}

// ───────────────────────────────────────────────────────────────────────── (b) two approvals at once

async function twoApprovalsAtOnceApplyOnce(): Promise<void> {
  const tables = outstationTables("needs_review");
  await withStandIn({ tables }, async (seen) => {
    generateIds("outstation_expense_reports", "report");
    releaseTogether((url, method) => method === "PATCH" && url.pathname === "/rest/v1/outstation_expense_requests", 2);
    const results = await Promise.allSettled([
      approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), { expectedRevision: SCREEN_REVISION }),
      approveOutstationRequestForPayroll(CLAIM_ID, admin("B-11"), { expectedRevision: SCREEN_REVISION }),
    ]);
    await settle();
    const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    assert.equal(writesTo(seen, "outstation_expense_requests").length, 2, "(b) both approvals reached the conditional status update");
    assert.equal(fulfilled.length, 1, "(b) HEADLINE: exactly one of two simultaneous approvals of the same claim applies");
    assert.equal(rejected.length, 1, "(b) and exactly one is refused");
    assert.ok(isOutstationClaimChangedError(rejected[0]), "(b) the losing approval is refused as \"the claim changed\" (409 at the routes), never a 500");
    assert.equal((rejected[0] as { code?: string }).code, OUTSTATION_CLAIM_CHANGED_CODE, "(b) with the claim-changed code");
    assert.equal(fulfilled[0].alreadyApproved, false, "(b) the winning approval ran the accept");
    assert.equal(fulfilled[0].payrollExpenseRows, 1, "(b) and pushed one payroll row");

    const claim = tables.outstation_expense_requests[0];
    assert.equal(claim.status, "accepted_by_admin", "(b) the claim is accepted");
    assert.equal(writesTo(seen, "outstation_expenses").length, 1, "(b) HEADLINE: the payroll row is written ONCE — the loser never pushed");
    assert.deepEqual(
      tables.outstation_expenses.map((row) => [row.trip_id, row.total]),
      [[TRIP_ID, 520]],
      "(b) one payroll row for the trip, for the claimed 520.00",
    );
    assert.equal(tables.outstation_expense_reports.length, 1, "(b) one payroll report row, not one per approver");
    assert.equal(addedToPayrollAudits(tables).length, 1, "(b) one \"accepted and added to payroll\" audit row, not two");
    assert.deepEqual(notificationWrites(seen), [], "(b) approving an ordinary claim notifies nobody");
  });

  // F-PAY-015: a third approve, on the now-accepted claim, from a screen showing its current version,
  // with nothing new to say — changes nothing.
  await withStandIn({ tables }, async (seen) => {
    const before = stored(tables);
    const again = await approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), {
      expectedRevision: outstationClaimRevision(tables.outstation_expense_requests[0].updated_at),
    });
    await settle();
    assert.equal(again.alreadyApproved, true, "(b) F-PAY-015: approving an accepted, unchanged claim says it was already approved");
    assert.equal(again.payrollExpenseRows, 0, "(b) F-PAY-015: and pushes nothing");
    assert.deepEqual(tableWrites(seen), [], "(b) F-PAY-015: and writes nothing — no status write, no second push, no second audit row");
    assert.deepEqual(stored(tables), before, "(b) F-PAY-015: every table is exactly as it was");
  });
}

export async function runOutstationReapproveRollbackAndRaceTests(): Promise<void> {
  await approveRefusedWhenThePayrollPushFails();
  await approveRefusedWhenTheAuditFails();
  await twoApprovalsAtOnceApplyOnce();
}
