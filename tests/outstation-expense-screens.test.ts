import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeOutstationRequests } from "../src/lib/employee-360/deep-service.ts";
import { decidedTripAmount } from "../src/lib/field-activity/report.ts";
import { mergeRequestAndLedgerExpenses } from "../src/lib/outstation/expenses.ts";

// Screens that read the two expense tables lost HR's decision or miscounted (owner, 2026-11-03,
// "build 6"). Payroll is not one of them: what it pays reads the ledger directly, and this test also
// pins that nothing here reached it.
export function runOutstationExpenseScreensTests() {
  const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const row = (tripId: string, approvedAmount: number | null, hrComment = "") => ({ approvedAmount, hrComment, tripId });

  // ── 1. The merge keeps HR's cut, and each trip appears once ─────────────────────────────────────
  const { historical, live } = mergeRequestAndLedgerExpenses(
    [row("OUTSTATION-1", 700, "two nights only"), row("IMPORTED-9", 300)],
    [row("OUTSTATION-1", null), row("OUTSTATION-2", null)],
  );
  assert.equal(live[0].approvedAmount, 700, "the request wears HR's trimmed figure from the row about to be dropped");
  assert.equal(live[0].hrComment, "two nights only");
  assert.equal(live[1].approvedAmount, null, "a trip nobody decided stays undecided");
  assert.deepEqual(historical.map((h) => h.tripId), ["IMPORTED-9"], "the shadowed ledger row is gone, so the trip is never counted twice");
  const portal = source("src/lib/employee-portal/service.ts");
  assert.equal((portal.match(/mergeRequestAndLedgerExpenses\(/g) ?? []).length, 2, "the portal dashboard and Team Comparison both use the merge");
  assert.ok(!portal.includes("dedupeHistoricalExpensesByTrip("), "a bare dedupe is what dropped HR's cut from these screens");
  assert.match(source("src/lib/outstation/expenses.ts"), /= mergeRequestAndLedgerExpenses\(\s*historicalExpenses,/, "the unified read uses the same merge");

  // ── 2. Team Comparison reads every request, not the first 1,000 ─────────────────────────────────
  const portalRead = portal.slice(portal.indexOf("async function listOutstationExpensesForPortal"));
  assert.match(portalRead.slice(0, 900), /fetchAllRows<Record<string, unknown>>\(/, "an unpaged read stops at 1,000 rows and says nothing");

  // ── 3. Field activity reads the decision from where it is stored ────────────────────────────────
  const ledger = { approved_amount: null as number | null, hr_approved: true as boolean | null, status: "approved" as string | null, total: 1000 as number | null };
  assert.equal(decidedTripAmount("accepted_by_admin", { ...ledger, approved_amount: 700 }), 700, "HR's cut");
  assert.equal(decidedTripAmount("accepted_by_admin", ledger), 1000, "approved uncut pays the claim");
  assert.equal(decidedTripAmount("submitted", { ...ledger, hr_approved: false, status: "Pending" }), null, "undecided stays undecided");
  assert.equal(decidedTripAmount("submitted", undefined), null);
  assert.equal(decidedTripAmount("rejected_by_admin", undefined), 0, "a rejection with no ledger row is decided");
  assert.equal(decidedTripAmount("submitted", { ...ledger, hr_approved: false, status: "Rejected" }), 0);
  assert.ok(!source("src/lib/field-activity/report.ts").includes("record.approved_total"), "the request table has no such column");

  // ── 4. Employee 360's Claimed leaves out what can never be paid ─────────────────────────────────
  const request = (status: string | null, claimed: number) => ({
    claimed_total_amount: claimed, eligibility_status: "eligible", expected_total_amount: claimed, status, territory_validation_status: "matched",
  });
  const summary = summarizeOutstationRequests([request("submitted", 100), request("rejected_by_admin", 900), request("accepted_by_admin", 50), request(null, 5)]);
  assert.equal(summary.claimedTotal, 155, "a rejected claim is not in Claimed");
  assert.equal(summary.expectedTotal, 155);
  assert.equal(summary.tripCount, 3);
  assert.equal(summary.rejectedCount, 1, "it is counted, and said");
  assert.equal(summarizeOutstationRequests([request("rejected_by_system", 10)]).hasData, true, "a person with only rejected trips still has outstation data to show");

  // ── 5. The home count includes a claim sent back for review ─────────────────────────────────────
  const home = source("src/lib/employee-portal/home-snapshot.ts");
  assert.match(home, /\.in\("status", \[\.\.\.OUTSTATION_UNDECIDED_STATUSES\]\)/, "needs_review waits for a person too");

  // ── 6. Payroll was not touched: both money paths still read the ledger itself ───────────────────
  assert.match(source("src/lib/automated-payroll/recommend.ts"), /\.from\("outstation_expenses"\)/);
  const expenses = source("src/lib/outstation/expenses.ts");
  const totals = expenses.slice(expenses.indexOf("export async function getApprovedExpenseTotalsForPayroll"));
  assert.match(totals.slice(0, 1200), /outstation_expenses|EXPENSES_TABLE|EXPENSE_TABLE/, "the payroll template pre-fill reads the ledger");
  assert.ok(!totals.slice(0, 1200).includes("mergeRequestAndLedgerExpenses"));
}
