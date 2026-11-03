import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  expenseMonthGaps,
  expenseMonthWasTypedByHand,
  pickExpenseMonth,
  reconcileExpenses,
  type ExpenseMonthFacts,
} from "../src/lib/automated-payroll/expense-reconciliation.ts";

const NONE = new Set<string>();

function run(month: ExpenseMonthFacts, extra: Partial<Parameters<typeof reconcileExpenses>[0]> = {}) {
  return reconcileExpenses({ heldCompacts: NONE, leftCompacts: NONE, month, names: new Map([["b1", "Ahmed"]]), ...extra });
}

const trip = (compact: string, payable: number, state: "approved" | "pending" | "rejected" = "approved") => ({ compact, payable, state });
const paid = (compact: string, expenses: number) => ({ compact, expenses, fullName: `Person ${compact}` });

export function runExpensePayslipReconciliationTests() {
  // The four findings.
  assert.equal(run({ paid: [paid("b1", 100)], trips: [trip("b1", 100)] }).matches, 1);
  assert.equal(run({ paid: [paid("b1", 100.4)], trips: [trip("b1", 100)] }).rows.length, 0, "under half a pound is rounding");

  const unpaid = run({ paid: [], trips: [trip("b1", 500)] }).rows[0];
  assert.equal(unpaid.finding, "approved not paid");
  assert.equal(unpaid.fullName, "Ahmed", "a person with no payslip row is still named");

  const extra = run({ paid: [paid("b1", 300)], trips: [] }).rows[0];
  assert.equal(extra.finding, "no approved trip this month", "never called wrong: HR can pay this on purpose");

  const trimmed = run({ paid: [paid("b1", 300)], trips: [trip("b1", 500)] }).rows[0];
  assert.equal(trimmed.finding, "different amount");
  assert.equal(trimmed.gap, -200);

  // A rejected trip is in no figure; a pending one is shown beside, never counted as approved.
  assert.equal(run({ paid: [], trips: [trip("b1", 500, "rejected")] }).rows.length, 0);
  const pending = run({ paid: [paid("b1", 200)], trips: [trip("b1", 200, "pending")] }).rows[0];
  assert.equal(pending.finding, "no approved trip this month", "a pending trip is not in the figure (owner, 2026-09-08)");
  assert.equal(pending.pending, 200);

  // Held at publish is not unpaid.
  const held = run({ paid: [], trips: [trip("b1", 500)] }, { heldCompacts: new Set(["b1"]) }).rows[0];
  assert.equal(held.finding, "held at publish");

  // A leaver is flagged, because a final settlement is not in salary_records.
  const leaver = run({ paid: [], trips: [trip("b1", 500)] }, { leftCompacts: new Set(["b1"]) }).rows[0];
  assert.equal(leaver.finding, "approved not paid");
  assert.match(leaver.note ?? "", /final settlement/);

  // Carried is an inference: labelled, and both figures still show.
  const carried = run({ paid: [], trips: [trip("b1", 500)] }, { nextGaps: new Map([["b1", 500]]) }).rows[0];
  assert.equal(carried.finding, "may have been carried");
  assert.equal(carried.gap, -500, "never netted off");
  assert.match(carried.note ?? "", /inference/i);
  assert.equal(
    run({ paid: [], trips: [trip("b1", 500)] }, { nextGaps: new Map([["b1", 200]]) }).rows[0].finding,
    "approved not paid",
    "a neighbour off by another amount explains nothing",
  );
  assert.deepEqual([...expenseMonthGaps({ paid: [paid("b1", 100)], trips: [trip("b1", 100)] })], [], "a matching month has no gap");

  assert.equal(expenseMonthWasTypedByHand(7, 2026), true);
  assert.equal(expenseMonthWasTypedByHand(9, 2026), false);

  const months = [{ month: 9, year: 2026 }, { month: 8, year: 2026 }];
  assert.deepEqual(pickExpenseMonth("2026-08", months), { month: 8, year: 2026 }, "the address picks an offered month");
  assert.equal(pickExpenseMonth("2025-08", months), null, "a month the screen does not offer is not read");
  assert.equal(pickExpenseMonth("nonsense", months), null);
  assert.equal(pickExpenseMonth(null, months), null);

  // What the reads may and may not do, pinned at the source.
  const server = readFileSync("src/lib/automated-payroll/expense-reconciliation-server.ts", "utf8");
  assert.match(server, /\.select\("hr_id,full_name,expenses"\)/, "this check selects nothing else from a salary row");
  assert.doesNotMatch(server, /imported_payroll_batch_id/, "an empty import stamp never means unpaid, so the stamp is never read");
  assert.doesNotMatch(server, /\.(insert|update|upsert|delete)\(/, "it writes nothing");
  assert.match(server, /if \(error\) throw new Error\(`Could not read the published payslips/, "a failed read is never a zero");
  const page = readFileSync("app/(admin)/admin/outstation/expense-command/page.tsx", "utf8");
  assert.ok(
    page.indexOf('assertOutstationAdminAccess(access, "read")') < page.indexOf("loadExpenseReconciliation("),
    "the page guard comes before the read",
  );
  const panel = readFileSync("src/components/outstation/expense-payslip-reconciliation-panel.tsx", "utf8");
  assert.doesNotMatch(panel, /<button|<form|onClick|fetch\(/, "the screen offers no action");
  assert.doesNotMatch(panel, /overflow-x-auto|truncate|rounded/, "fits the screen, square edges, no ellipsis");
}
