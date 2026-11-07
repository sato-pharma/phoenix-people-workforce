import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  paidExpenseEmployees,
  planPaidExpenseStamp,
  type StampCandidateRow,
} from "../src/lib/automated-payroll/expense-stamp.ts";
import type { StoredExpenseDecision } from "../src/lib/outstation/approval-state.ts";
import { summarizePayrollExpenses } from "../src/lib/outstation/expense-metrics.ts";
import {
  describeImportedHistoryRefusal,
  isImportedHistoryTrip,
  planImportedHistoryWrites,
} from "../src/lib/outstation/imported-history.ts";
import { compactHrKey } from "../src/lib/payroll/copilot/feeders.ts";
import type { PayrollExpenseApproval } from "../src/lib/payroll/types.ts";

/**
 * The owner's two answers on the outstation-expense meaning sheet (2026-09-12), pinned.
 *
 * Q1 — "Yes — stamp them automatically", taking "the value that I edited not the original and if no
 * edit my side then take the original". Publishing a month now marks the outstation trips it paid.
 * Until then the wizard read that mark and never wrote it, so none of the 374 trips in production
 * carried one. Which trips: this payout period's APPROVED trips of an employee the run actually paid
 * expenses to. A held employee, a pending trip, a rejected trip and an already-marked trip are never
 * marked, and the total is taken at HR's edited figure.
 *
 * Q2 — "from to to june show all values only and donot give a notification to approve because they
 * were imported from outsoiyrce source". Trips dated before 1 July 2026 are values only: never counted
 * as awaiting a decision, never offered Approve / Reject, and a changed decision on one is refused by
 * the server. Every such trip in production is already decided, so this removes prompts, not money.
 */

function row(overrides: Partial<StampCandidateRow> & { id: string; hr_id: string }): StampCandidateRow {
  return {
    approved_amount: null,
    hr_approved: true,
    imported_payroll_batch_id: null,
    imported_to_payroll_at: null,
    status: "Approved",
    total: 0,
    ...overrides,
  };
}

function stored(overrides: Partial<StoredExpenseDecision>): StoredExpenseDecision {
  return {
    approvedAmount: null,
    approvedAt: "2026-06-20T10:00:00.000Z",
    approvedBy: "b-10",
    hrApproved: true,
    hrComment: "",
    hrStatus: "",
    status: "Approved",
    ...overrides,
  };
}

export function runOutstationPaidStampAndImportedHistoryTests() {
  // ── Q1: which trips a publish marks ──────────────────────────────────────────────────────────
  const plan = planPaidExpenseStamp({
    paid: [
      { compact: "B-12", expenses: 800 },
      { compact: "A-10", expenses: 0 },
      { compact: "B-5", expenses: 900 },
    ],
    rows: [
      // HR cut this claim from 800 to 500: the edited figure is what counts.
      row({ id: "s1", hr_id: "B-12", total: 800, approved_amount: 500 }),
      // Not edited: the claim stands.
      row({ id: "s2", hr_id: "B-12", total: 300 }),
      // Pending: not in the paid figure, so never marked.
      row({ id: "s3", hr_id: "B-12", total: 450, hr_approved: false, status: "" }),
      // Rejected: never paid, so never marked.
      row({ id: "s4", hr_id: "B-12", total: 700, hr_approved: false, status: "Rejected" }),
      // Already marked by an earlier batch: left as it is.
      row({ id: "s5", hr_id: "B-12", total: 200, imported_payroll_batch_id: "earlier-batch" }),
      // Held, so absent from the published rows: none of their trips is marked.
      row({ id: "s6", hr_id: "B-74", total: 600 }),
      // Published, but paid no expenses: nothing to mark.
      row({ id: "s7", hr_id: "A-10", total: 400 }),
      // Paid 900 against trips worth 1,000: still marked, and the difference is reported.
      row({ id: "s8", hr_id: "B-5", total: 1000 }),
    ],
  });

  assert.deepEqual(
    [...plan.rowIds].sort(),
    ["s1", "s2", "s8"],
    "a publish marks exactly the approved trips of employees it paid expenses to — never a pending, rejected, held, unpaid or already-marked trip",
  );
  assert.equal(
    plan.total,
    1800,
    "the marked total takes HR's edited figure where there is one (500, not 800) and the claim otherwise",
  );
  assert.equal(plan.employees, 2);
  assert.deepEqual(
    plan.differing,
    [{ compact: compactHrKey("B-5"), paid: 900, tripsTotal: 1000 }],
    "an employee whose paid figure differs from the marked trips is named, so the gap stays visible",
  );

  // ── Q2: what counts as imported history ──────────────────────────────────────────────────────
  assert.equal(isImportedHistoryTrip("2026-06-30"), true, "the last day of June is imported history");
  assert.equal(
    isImportedHistoryTrip("2026-06-30T00:00:00.000Z"),
    true,
    "the queue carries trip dates as ISO timestamps; the day is what decides",
  );
  assert.equal(isImportedHistoryTrip("2026-07-01"), false, "July's trips are Phoenix approvals");
  assert.equal(isImportedHistoryTrip(""), false, "an unreadable date keeps its controls rather than silently losing them");
  assert.equal(isImportedHistoryTrip("30/06/2026"), false);

  // ── Q2: the server refuses a changed decision on history, and preserves an untouched one ─────
  const storedByTripId = new Map<string, StoredExpenseDecision>([
    ["H1", stored({})],
    ["H2", stored({ hrApproved: false, status: "Rejected", hrComment: "duplicate trip" })],
    ["J1", stored({ hrApproved: false, status: "", approvedAt: null, approvedBy: null })],
  ]);
  const writes = planImportedHistoryWrites({
    records: [
      // June, sent back exactly as stored — it rides along in its report's record set on every Save.
      { date: "2026-06-12T00:00:00.000Z", hrApproved: true, status: "Approved", total: 400, approvedAmount: 400, tripId: "H1" },
      // June, rejection undone — a decision on imported history.
      { date: "2026-06-14T00:00:00.000Z", hrApproved: false, hrComment: "duplicate trip", status: "", total: 350, specialist: "Dina", tripId: "H2" },
      // July: an ordinary approval, untouched by this rule.
      { date: "2026-07-03T00:00:00.000Z", hrApproved: true, status: "Approved", total: 500, tripId: "J1" },
      // June with nothing stored yet: an upload of the outside source, which is how history arrives.
      { date: "2026-06-20T00:00:00.000Z", hrApproved: true, status: "Approved", total: 250, tripId: "H3" },
    ],
    storedByTripId,
  });
  assert.deepEqual(
    writes.refused,
    [{ name: "Dina", tripId: "H2" }],
    "a changed decision on a trip before July 2026 is refused — imported history is values only",
  );
  assert.deepEqual([...writes.preserveTripIds], ["H1"], "an untouched historical trip keeps its stored decision");
  const refusal = describeImportedHistoryRefusal(writes.refused);
  assert.match(refusal, /before 1 July 2026/);
  assert.match(refusal, /Dina/);
  assert.match(refusal, /Nothing was saved/);

  // ── Q2: history never counts as awaiting a decision ──────────────────────────────────────────
  const trip = (date: string, hrApproved: boolean, status: string) =>
    ({ allowance: 0, approvedAmount: null, date, hrApproved, km: 0, meetingAmount: 0, other: 0, specialist: "x", status, total: 100, travelCost: 0 }) as unknown as PayrollExpenseApproval;
  const summary = summarizePayrollExpenses([
    trip("2026-06-10T00:00:00.000Z", false, ""),
    trip("2026-07-10T00:00:00.000Z", false, ""),
    trip("2026-06-11T00:00:00.000Z", false, "Rejected"),
  ]);
  assert.equal(
    summary.pendingRows,
    1,
    "only July's undecided trip awaits a decision — an undecided June trip is imported history",
  );

  // ── Wiring: each rule is reached from the path that needs it ─────────────────────────────────
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const publishBody = runService.slice(runService.indexOf("export async function publishToPayslips"));
  assert.match(publishBody.slice(0, publishBody.indexOf("\nexport ")), /recordPaidExpenseStamp\(/, "publish marks the trips it paid");
  assert.deepEqual(
    paidExpenseEmployees([
      { compact: "B-12", onHold: false, row: { expenses: 800 } },
      { compact: "B-74", onHold: true, row: { expenses: 600 } },
    ]),
    [{ compact: "B-12", expenses: 800 }],
    "a held employee's trips are never marked",
  );

  const expenses = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  const saveBody = expenses.slice(expenses.indexOf("export async function savePayrollExpenseApprovals"));
  assert.match(saveBody, /planImportedHistoryWrites\(/, "the approvals save enforces values-only history on the server");
  assert.match(saveBody, /throw new Error\(describeImportedHistoryRefusal/);

  const portal = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  const countLine = portal.slice(portal.indexOf("const pendingApprovalCount"), portal.indexOf("const pendingApprovalCount") + 300);
  assert.match(countLine, /isImportedHistoryTrip\(expense\.date\)/, "the portal's Expense actions pending never counts imported history");
  assert.doesNotMatch(countLine, /!expense\.hrApproved\)\.length/, "a rejected trip is not an action pending");

  // Rebuilt 2026-11-07 (expense-review/): the reviewer decides, the hook counts.
  const deck = readFileSync("src/components/outstation/expense-review/review-deck/deck.tsx", "utf8");
  const workspace = readFileSync("src/components/outstation/expense-review/use-expense-review.ts", "utf8");
  assert.match(deck, /const valuesOnly = isImportedHistoryTrip\(record\.date\);/, "the reviewer reads imported history as values only");
  assert.equal(
    deck.match(/valuesOnly=\{valuesOnly\}/g)?.length,
    3,
    "the subject, the reason section and the decision bar are all values only for imported history",
  );
  assert.match(
    workspace,
    /pending: undecided\.filter\(\(record\) => !isImportedHistoryTrip\(record\.date\)\)/,
    "imported history is never counted, selected or bulk-approved as awaiting a decision",
  );
  assert.match(
    workspace,
    /\[\.\.\.pending, \.\.\.undecidedHistory, \.\.\.approved, \.\.\.rejected\]/,
    "an undecided historical trip still shows its values in the per-employee summary",
  );
}
