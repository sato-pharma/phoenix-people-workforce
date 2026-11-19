import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  OUTSTATION_CLAIM_CHANGED_CODE,
  isOutstationClaimChangedError,
  outstationClaimRevision,
} from "../src/lib/outstation/claim-revision.ts";
import { approveOutstationRequestForPayroll } from "../src/lib/outstation/service.ts";
import {
  RpcRaise,
  atomically,
  rpcCalls,
  snapshot,
  withStandIn,
  type Row,
  type RpcAnswer,
  type Seen,
  type Tables,
} from "./support/postgrest-transaction-stand-in.ts";

// BEHAVIOUR TESTS FOR APPROVING AN OUTSTATION EXPENSE CLAIM INTO PAYROLL (F-PAY-015 #315; REC-038 close-out,
// 19 Nov 2026 — owner: "fix the outstation approval so it is one step").
//
// approveOutstationRequestForPayroll reads the claim, checks the version the reviewer saw, works out the payroll
// report and row with the payroll save's own code (planPayrollExpenseSave, which writes nothing), and then makes
// ONE database call, phx_accept_outstation_claim_for_payroll (migration 20261119132423): the claim's acceptance
// pinned to the checked `updated_at`, the report row, the trip's `outstation_expenses` row and both audit rows,
// in one transaction. This file runs the REAL function against the in-memory PostgREST
// (tests/support/postgrest-transaction-stand-in.ts) — no network, no environment file, no real database, nobody
// notified — with that function modelled statement by statement from its migration inside `atomically`, which
// keeps nothing when the model raises, exactly as Postgres does:
//
//   (a) A FAILURE INSIDE THE CALL, AFTER THE CLAIM'S OWN UPDATE. The payroll row, or the audit rows, fail. Every
//       table afterwards equals the tables before (the claim still waits at the version the reviewer saw, no
//       report row, no payroll row, no record), the app writes nothing outside the call, and the approver is
//       refused with words saying nothing changed. Approving again from the same screen then pays the trip once.
//   (b) TWO APPROVALS AT ONCE. Two Super Admins approve the same claim, from the same screen version, at the same
//       moment. Exactly one applies; the other is refused as "the claim changed" (OutstationClaimChangedError, a
//       409 at the routes) and writes nothing; the payroll row, the report row and the records are written once.
//       A later approve of the now-accepted, unchanged claim makes no call at all (F-PAY-015).
//   A claim the evidence gate holds is accepted by the same one call, with no payroll row and the "HELD" record.

const CLAIM_ID = 4521;
const TRIP_ID = `OUTSTATION-${CLAIM_ID}`;
const STORED_AT = "2026-11-17T09:30:00.123456+00:00";
const SCREEN_REVISION = outstationClaimRevision(STORED_AT);
const ACCEPT = "phx_accept_outstation_claim_for_payroll";
const NOTHING_CHANGED = "The claim could not be approved, so nothing was changed";

const admin = (hrId: "B-10" | "B-11") =>
  createAccessContext({ hrId, loginId: `admin.${hrId.toLowerCase()}`, role: "Super Admin", source: "session" });

/** Lets any detached follow-up (the payroll resync, the audit outbox drain) finish inside the stand-in. */
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
const pushedToPayrollAudits = (tables: Tables) =>
  (tables.audit_logs ?? []).filter((row) => String(row.summary) === `Outstation request ${CLAIM_ID} accepted; expense pushed to payroll.`);

/** The `outstation_expenses` columns the function's insert names, in its order (the migration, step 2). */
const EXPENSE_COLUMNS = [
  "allowance", "am_workload", "approved_amount", "approved_at", "approved_by", "description", "hr_id", "expense_date",
  "from_location", "hr_approved", "hr_comment", "hr_notes", "hr_status", "km", "location", "meeting_amount", "other_amount",
  "payout_month", "payout_year", "pharmacy_workload", "pm_workload", "request_type", "report_id", "source_file_name",
  "source_row", "specialist", "status", "to_date", "to_location", "total", "transportation_type", "travel_cost", "trip_id",
  "trip_type", "updated_at",
] as const;

type Statement = "claim" | "report" | "expenses" | "audit";
const TIMEOUT = () => new RpcRaise("57014", "canceling statement due to statement timeout", 500);

/**
 * phx_accept_outstation_claim_for_payroll, statement by statement from 20261119132423, in one transaction.
 * `failAt` makes that statement fail as a statement timeout would; `ran` records, per call, the statements reached.
 */
function acceptClaimFunction(options: { failAt?: Statement; ran?: Statement[][] } = {}) {
  let reportSerial = 0;
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer =>
    atomically(tables, (draft) => {
      const ran: Statement[] = [];
      options.ran?.push(ran);
      const reach = (statement: Statement) => {
        ran.push(statement);
        if (options.failAt === statement) throw TIMEOUT();
      };

      // 1. The claim, pinned to the version the reviewer approved: a claim that moved raises before anything else.
      reach("claim");
      const claim = (draft.outstation_expense_requests ?? []).find(
        (row) => Number(row.id) === Number(args.p_request_id) && String(row.updated_at) === String(args.p_expected_updated_at),
      );
      if (!claim) throw new RpcRaise("P0001", "outstation_claim_changed: the claim changed after it was read, so it was not approved");
      Object.assign(claim, {
        approval_reason: args.p_approval_reason ?? "",
        calculation_status: args.p_status,
        status: args.p_status,
        updated_at: args.p_updated_at,
      });

      // 2. The report row and the trip's row, only when rows are given.
      const incoming = Array.isArray(args.p_expense_rows) ? (args.p_expense_rows as Row[]) : [];
      let reportId = (args.p_report_id as string | null) ?? null;
      const expenses: Row[] = [];
      if (incoming.length > 0) {
        reach("report");
        const report = (args.p_report ?? {}) as Row;
        const values = {
          approved_rows: report.approved_rows,
          file_name: report.file_name,
          row_count: report.row_count,
          total_expenses: report.total_expenses,
          trip_date_from: report.trip_date_from,
          trip_date_to: report.trip_date_to,
          updated_at: report.updated_at,
        };
        const reports = (draft.outstation_expense_reports ??= []);
        if (reportId) Object.assign(reports.find((row) => String(row.id) === reportId) ?? {}, values);
        else {
          reportId = `report-${(reportSerial += 1)}`;
          reports.push({ id: reportId, ...values });
        }
        reach("expenses");
        const rows = (draft.outstation_expenses ??= []);
        for (const raw of incoming) {
          const row: Row = Object.fromEntries(EXPENSE_COLUMNS.map((column) => [column, raw[column] ?? null]));
          row.report_id = reportId;
          const existing = rows.find((candidate) => String(candidate.trip_id) === String(row.trip_id));
          if (existing) Object.assign(existing, row);
          else rows.push(row);
          expenses.push({ ...(existing ?? row) });
        }
      }

      // 3. The approval's audit rows.
      reach("audit");
      for (const audit of (args.p_audits ?? []) as Row[]) {
        (draft.audit_logs ??= []).push({
          actor_login_id: audit.actor_login_id ?? "system",
          entity_id: audit.entity_id ?? null,
          entity_type: audit.entity_type,
          new_values: audit.new_values ?? null,
          old_values: audit.old_values ?? null,
          summary: audit.summary,
        });
      }
      return { body: { expenses, report_id: reportId, request: { ...claim } }, status: 200 };
    });
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
function outstationTables(status: string, claimOverrides: Row = {}): Tables {
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
        ...claimOverrides,
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

// ──────────────────────────────────────────────── (a) a failure inside the one call, after the claim's update

async function approveIsAllOrNothingWhenAStatementFails(failAt: "expenses" | "audit"): Promise<void> {
  const label = failAt === "expenses" ? "(a) payroll row" : "(a) record";
  const tables = outstationTables("needs_review");
  const before = stored(tables);
  const ran: Statement[][] = [];
  await withStandIn({ rpc: { [ACCEPT]: acceptClaimFunction({ failAt, ran }) }, tables }, async (seen) => {
    let refusal: unknown = null;
    let answer: unknown = null;
    try {
      answer = await approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), { expectedRevision: SCREEN_REVISION });
    } catch (error) {
      refusal = error;
    }
    await settle();
    assert.equal(answer, null, `${label}: an approval whose one database step failed must not hand back an approved claim`);
    assert.ok(refusal instanceof Error, `${label}: the approver is refused`);
    assert.ok(
      refusal.message.startsWith(NOTHING_CHANGED),
      `${label}: and told in words that nothing was changed, so a retry is safe: ${refusal.message}`,
    );
    assert.ok(!isOutstationClaimChangedError(refusal), `${label}: a failed write is not dressed up as "the claim changed"`);
    assert.equal(rpcCalls(seen, ACCEPT).length, 1, `${label}: the approval made its one database call`);
    assert.equal(ran.length, 1, `${label}: once`);
    assert.equal(ran[0][0], "claim", `${label}: the call updated the claim first…`);
    assert.equal(ran[0].at(-1), failAt, `${label}: …and the forced failure came AFTER that update, inside the same call`);
    const sent = rpcCalls(seen, ACCEPT)[0].body as { p_audits?: unknown[]; p_expense_rows?: unknown[] };
    assert.equal(sent.p_expense_rows?.length, 1, `${label}: the call carried the trip's payroll row`);
    assert.equal(sent.p_audits?.length, 2, `${label}: and both records`);
    assert.deepEqual(tableWrites(seen), [], `${label}: HEADLINE: the app wrote nothing outside the one call — no status write, no push, no record, no outbox row`);
    assert.deepEqual(
      stored(tables),
      before,
      `${label}: HEADLINE: every table afterwards equals the tables before — the claim still waits at the version the reviewer saw, with no report row, no payroll row and no record`,
    );
    assert.deepEqual(notificationWrites(seen), [], `${label}: nobody is notified of an approval that failed`);
  });

  // The approver presses Approve again on the same screen: it is still the claim he saw, and the trip reaches
  // payroll exactly once.
  await withStandIn({ rpc: { [ACCEPT]: acceptClaimFunction() }, tables }, async (seen) => {
    assert.equal(
      outstationClaimRevision(tables.outstation_expense_requests[0].updated_at),
      SCREEN_REVISION,
      `${label}: the failed attempt left the claim's version untouched, so the reviewer's own screen is still current`,
    );
    const retried = await approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), { expectedRevision: SCREEN_REVISION });
    await settle();
    assert.equal(retried.alreadyApproved, false, `${label}: approving again runs the accept`);
    assert.equal(retried.request.status, "accepted_by_admin", `${label}: and the claim reads accepted`);
    assert.equal(retried.payrollExpenseRows, 1, `${label}: and says one payroll row was written`);
    assert.deepEqual(
      tables.outstation_expenses.map((row) => [row.trip_id, row.total, row.hr_approved, row.report_id]),
      [[TRIP_ID, 520, true, "report-1"]],
      `${label}: the retry leaves exactly one payroll row for the trip, for the claimed 520.00, on its report`,
    );
    assert.equal(tables.outstation_expense_reports.length, 1, `${label}: one payroll report row`);
    assert.equal(pushedToPayrollAudits(tables).length, 1, `${label}: one "expense pushed to payroll" record`);
    assert.equal(addedToPayrollAudits(tables).length, 1, `${label}: one "accepted and added to payroll" record, from the attempt that did it`);
    assert.deepEqual(tableWrites(seen), [], `${label}: and every write was the one call's`);
  });
}

async function approveIsAllOrNothingWhenThePayrollRowFails(): Promise<void> {
  await approveIsAllOrNothingWhenAStatementFails("expenses");
}

async function approveIsAllOrNothingWhenTheRecordFails(): Promise<void> {
  await approveIsAllOrNothingWhenAStatementFails("audit");
}

// ───────────────────────────────────────────────────────────────────────── (b) two approvals at once

async function twoApprovalsAtOnceApplyOnce(): Promise<void> {
  const tables = outstationTables("needs_review");
  const ran: Statement[][] = [];
  await withStandIn({ rpc: { [ACCEPT]: acceptClaimFunction({ ran }) }, tables }, async (seen) => {
    releaseTogether((url, method) => method === "POST" && url.pathname === `/rest/v1/rpc/${ACCEPT}`, 2);
    const results = await Promise.allSettled([
      approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), { expectedRevision: SCREEN_REVISION }),
      approveOutstationRequestForPayroll(CLAIM_ID, admin("B-11"), { expectedRevision: SCREEN_REVISION }),
    ]);
    await settle();
    const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    assert.equal(rpcCalls(seen, ACCEPT).length, 2, "(b) both approvals reached the one database call");
    assert.equal(fulfilled.length, 1, "(b) HEADLINE: exactly one of two simultaneous approvals of the same claim applies");
    assert.equal(rejected.length, 1, "(b) and exactly one is refused");
    assert.ok(isOutstationClaimChangedError(rejected[0]), "(b) the losing approval is refused as \"the claim changed\" (409 at the routes), never a 500");
    assert.equal((rejected[0] as { code?: string }).code, OUTSTATION_CLAIM_CHANGED_CODE, "(b) with the claim-changed code");
    assert.deepEqual(
      ran.map((statements) => statements.join(" → ")),
      ["claim → report → expenses → audit", "claim"],
      "(b) the loser's call stopped at the claim's pinned update — it reached no payroll write and no record",
    );
    assert.equal(fulfilled[0].alreadyApproved, false, "(b) the winning approval ran the accept");
    assert.equal(fulfilled[0].payrollExpenseRows, 1, "(b) and wrote one payroll row");

    const claim = tables.outstation_expense_requests[0];
    assert.equal(claim.status, "accepted_by_admin", "(b) the claim is accepted");
    assert.deepEqual(
      tables.outstation_expenses.map((row) => [row.trip_id, row.total]),
      [[TRIP_ID, 520]],
      "(b) HEADLINE: one payroll row for the trip, for the claimed 520.00 — the loser never pushed",
    );
    assert.equal(tables.outstation_expense_reports.length, 1, "(b) one payroll report row, not one per approver");
    assert.equal(pushedToPayrollAudits(tables).length, 1, "(b) one \"expense pushed to payroll\" record, not two");
    assert.equal(addedToPayrollAudits(tables).length, 1, "(b) one \"accepted and added to payroll\" record, not two");
    assert.deepEqual(tableWrites(seen), [], "(b) every write was the winning call's");
    assert.deepEqual(notificationWrites(seen), [], "(b) approving an ordinary claim notifies nobody");
  });

  // F-PAY-015: a third approve, on the now-accepted claim, from a screen showing its current version,
  // with nothing new to say — changes nothing.
  await withStandIn({ rpc: { [ACCEPT]: acceptClaimFunction() }, tables }, async (seen) => {
    const before = stored(tables);
    const again = await approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), {
      expectedRevision: outstationClaimRevision(tables.outstation_expense_requests[0].updated_at),
    });
    await settle();
    assert.equal(again.alreadyApproved, true, "(b) F-PAY-015: approving an accepted, unchanged claim says it was already approved");
    assert.equal(again.payrollExpenseRows, 0, "(b) F-PAY-015: and pushes nothing");
    assert.equal(rpcCalls(seen, ACCEPT).length, 0, "(b) F-PAY-015: and makes no database call at all");
    assert.deepEqual(tableWrites(seen), [], "(b) F-PAY-015: and writes nothing — no status write, no second push, no second record");
    assert.deepEqual(stored(tables), before, "(b) F-PAY-015: every table is exactly as it was");
  });
}

// ───────────────────────────────────────────────────────── a claim the evidence gate holds

async function aHeldClaimIsAcceptedWithNoPayrollRow(): Promise<void> {
  // An August trip with no arrival photo: the two-photo gate holds it out of payroll, but it is still accepted.
  const tables = outstationTables("needs_review", {
    evidence_gate_status: "pending_arrival_photo",
    workload_gate_status: "pending_workload",
  });
  await withStandIn({ rpc: { [ACCEPT]: acceptClaimFunction() }, tables }, async (seen) => {
    const approved = await approveOutstationRequestForPayroll(CLAIM_ID, admin("B-10"), { expectedRevision: SCREEN_REVISION });
    await settle();
    assert.equal(rpcCalls(seen, ACCEPT).length, 1, "held: a held claim is accepted by the same one call");
    const sent = rpcCalls(seen, ACCEPT)[0].body as { p_expense_rows?: unknown[]; p_report?: unknown };
    assert.deepEqual([sent.p_expense_rows, sent.p_report], [[], null], "held: HEADLINE: the call carries no payroll row and no report");
    assert.equal(approved.request.status, "accepted_by_admin", "held: the claim reads accepted");
    assert.equal(approved.payrollExpenseRows, 0, "held: and nothing reached payroll");
    assert.equal(approved.gate.isPayrollEligible, false, "held: the gate says why");
    assert.deepEqual(tables.outstation_expenses, [], "held: no payroll row exists for the trip");
    assert.deepEqual(tables.outstation_expense_reports, [], "held: and no report row");
    assert.deepEqual(
      (tables.audit_logs ?? []).map((row) => String(row.summary).split(":")[0]),
      [`Outstation request ${CLAIM_ID} accepted (accepted_by_admin) but HELD out of payroll`],
      "held: one record, saying the claim was accepted and HELD — never one saying it reached payroll",
    );
    assert.deepEqual(tableWrites(seen), [], "held: every write was the one call's");
  });
}

export async function runOutstationReapproveRollbackAndRaceTests(): Promise<void> {
  await approveIsAllOrNothingWhenThePayrollRowFails();
  await approveIsAllOrNothingWhenTheRecordFails();
  await twoApprovalsAtOnceApplyOnce();
  await aHeldClaimIsAcceptedWithNoPayrollRow();
}
