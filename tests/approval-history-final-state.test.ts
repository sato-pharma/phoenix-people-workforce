import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";
import {
  buildLeaveHistory,
  directOrderHistoryRow,
  directOrderHistoryTitle,
  resolveHistoryOutcome,
  type HistoryLeaveRequestRow,
  type HistoryLeaveStepRow,
} from "../src/lib/action-center/approval-history-outcome.ts";
import {
  formatHistoryMoney,
  formatHistoryUnits,
  historyDate,
  historyPlanPeriod,
  historyWeekLabel,
} from "../src/lib/action-center/approval-history-format.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Action Center's "decisions I made" list reported where the VIEWER's own step ended, not where
// the request ended. Found on the National Sales Manager's own screen (owner, 2026-10-26):
//   - Ahmed Abdallah's leaves of 16, 19 and 24 Aug read APPROVED; HR rejected all three later.
//   - Mostafa Galal's leave is still with HR and read plain APPROVED.
//   - Hany Saad's leave was missing: its request row stores the manager id as "AA" while the step
//     is the NSM's own, and the steps feed only asked for two step keys.
//   - Direct orders showed one product, no pharmacy; marketing rows showed a request code;
//     money and dates were raw (`25344 EGP`, `2026-10-25`).
// Every fixture below has the shape of one of those production rows.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_URL = new URL("../src/lib/action-center/service.ts", import.meta.url);

const decode = (raw: string | null | undefined) => {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "approved" || v === "rejected" || v === "returned" ? v : null;
};

const deps = {
  decidedByMe: (value: unknown) => String(value ?? "").toLowerCase() === "a-12",
  decode,
  personName: (_id: string, fallback: string) => fallback,
  hrefFor: (id: string) => `/leave/${id}`,
};

function requestRow(over: Partial<HistoryLeaveRequestRow> & { id: string }): HistoryLeaveRequestRow {
  return {
    manager_decision: "approved",
    manager_decision_at: "2026-08-10T09:00:00Z",
    manager_decision_by_hr_id: "A-12",
    hr_decision: null,
    hr_decision_at: null,
    hr_decision_by_hr_id: null,
    employee_name: "Ahmed Abdallah",
    employee_hr_id: "C-1",
    vacation_type: "annual",
    start_date: "2026-08-16",
    status: "approved",
    ...over,
  };
}

export async function runApprovalHistoryFinalStateTests() {
  // ── 1. The outcome is the request's FINAL state ───────────────────────────
  const ahmed = buildLeaveHistory(
    { requests: [requestRow({ id: "r-ahmed", status: "rejected", hr_decision: "rejected" })], steps: [] },
    deps,
  );
  assert.equal(ahmed.length, 1);
  assert.equal(ahmed[0].decision, "rejected", "RED a leave HR rejected must read REJECTED, whatever the viewer's own step said");
  assert.equal(ahmed[0].outcomeNote, "Approved by you · rejected later");

  const mostafa = buildLeaveHistory(
    { requests: [requestRow({ id: "r-mostafa", status: "pending_hr", start_date: "2026-10-24" })], steps: [] },
    deps,
  );
  assert.equal(mostafa[0].decision, "approved");
  assert.equal(mostafa[0].outcomeNote, "Approved by you · waiting for HR");

  const agreed = buildLeaveHistory({ requests: [requestRow({ id: "r-ok", status: "approved" })], steps: [] }, deps);
  assert.equal(agreed[0].decision, "approved");
  assert.equal(agreed[0].outcomeNote, null, "no note when the final state is what the viewer did");

  // a return: the manager column is NULL (its check allows only approved/rejected), the status says so
  const returned = buildLeaveHistory(
    { requests: [requestRow({ id: "r-ret", manager_decision: null, status: "returned" })], steps: [] },
    deps,
  );
  assert.equal(returned[0].decision, "returned");

  assert.deepEqual(resolveHistoryOutcome("approved", { state: "cancelled" }), {
    decision: "approved",
    note: "Approved by you · cancelled afterwards",
  });
  assert.deepEqual(resolveHistoryOutcome("approved", { state: "unknown" }), { decision: "approved", note: null });

  // ── 2. A leave found ONLY through the steps table is listed, once ─────────
  const hanyStep: HistoryLeaveStepRow = {
    request_id: "r-hany",
    status: "approved",
    decided_at: "2026-07-20T10:00:00Z",
    v2_vacation_requests: {
      employee_name: "Hany Saad",
      employee_hr_id: "C-2",
      vacation_type: "annual",
      start_date: "2026-07-29",
      status: "approved",
    },
  };
  const arrayEmbed: HistoryLeaveStepRow = {
    ...hanyStep,
    request_id: "r-array",
    v2_vacation_requests: [{ ...(hanyStep.v2_vacation_requests as object), status: "rejected" }],
  };
  const merged = buildLeaveHistory(
    {
      requests: [requestRow({ id: "r-ahmed", status: "rejected" })],
      // the same request in both feeds must not appear twice
      steps: [hanyStep, arrayEmbed, { ...hanyStep, request_id: "r-ahmed" }],
    },
    deps,
  );
  assert.deepEqual(merged.map((i) => i.id).sort(), ["history:leave:r-array", "history:leave:r-ahmed", "history:leave:r-hany"].sort());
  assert.equal(merged.find((i) => i.id === "history:leave:r-hany")?.employeeName, "Hany Saad");
  assert.equal(merged.find((i) => i.id === "history:leave:r-array")?.decision, "rejected", "an array-shaped embed is read too");

  // ── 3. Direct orders: every product, the pharmacy, the final status ───────
  const basket = {
    status: "rejected",
    product_name: "Lacto Advanced 1",
    qty: 72,
    sales_value: 86625,
    direct_order_pharmacies: { pharmacy_name: "Zamzam Pharmacy" },
    direct_order_request_items: [
      { line_no: 2, product_name: "Lacto Advanced 2", qty: 24 },
      { line_no: 1, product_name: "Lacto Advanced 1", qty: 72 },
    ],
  };
  const title = directOrderHistoryTitle(basket);
  assert.match(title, /Zamzam Pharmacy/, "RED the pharmacy must be named");
  assert.match(title, /Lacto Advanced 1 × 72/);
  assert.match(title, /Lacto Advanced 2 × 24/, "RED every product of a basket is listed, not the first alone");
  assert.doesNotMatch(title, /\b96\b/, "units of different products are never added");
  assert.match(title, /86,625 EGP/);
  const order = directOrderHistoryRow("approved", basket);
  assert.equal(order.decision, "rejected", "RED a direct order that ended rejected reads rejected");
  assert.equal(order.note, "Approved by you · rejected later");
  assert.equal(directOrderHistoryRow("approved", { ...basket, status: "pending_approval" }).note, "Approved by you · waiting for the next approver");

  // ── 4. Formats ────────────────────────────────────────────────────────────
  assert.equal(formatHistoryMoney(25344), "25,344 EGP");
  assert.equal(formatHistoryMoney("1234567.5"), "1,234,567.5 EGP");
  assert.equal(formatHistoryMoney(null), "0 EGP");
  assert.equal(formatHistoryUnits(1200), "1,200");
  assert.equal(historyDate("2026-10-25"), "25 Oct 2026");
  assert.equal(historyDate("2026-10-25T22:30:00Z"), "25 Oct 2026", "a date-only column is read in UTC, never slid by the Cairo offset");
  assert.equal(historyDate(""), "");
  assert.equal(historyDate("not a date"), "");
  assert.equal(historyWeekLabel("2026-10-12", "2026-W42"), "12 Oct 2026 to 18 Oct 2026");
  assert.equal(historyWeekLabel("garbage", "2026-W42"), "2026-W42");
  assert.equal(historyPlanPeriod("2026-10-12", "2026-10-18", "2026-W42"), "12 Oct 2026 to 18 Oct 2026");
  assert.equal(historyPlanPeriod(null, null, "2026-W42"), "2026-W42");

  // ── 5. The wiring: the source pins that make the above reachable ──────────
  const code = stripComments(readFileSync(SERVICE_URL, "utf8")).replace(/\r\n/g, "\n");
  const stepsFeed = code.slice(code.indexOf('feed("leave"'), code.indexOf('feed("direct_order"'));
  assert.ok(stepsFeed.includes('from("v2_vacation_approval_steps")'), "the leave steps feed is still there");
  assert.doesNotMatch(
    stepsFeed,
    /\.in\(\s*"step_key"/,
    "RED the steps feed must read EVERY step key — a filter hides the leaves a drifted request row never names (Hany Saad's)",
  );
  assert.match(stepsFeed, /v2_vacation_requests\([^)]*\bstatus\b/, "RED the steps feed must carry the request's status — it is the FINAL outcome");
  assert.match(code, /buildLeaveHistory\(/, "the leave rows are built by the tested module, not re-derived inline");
  assert.match(code, /directOrderHistoryRow\(/, "the direct-order rows are built by the tested module");
  assert.doesNotMatch(
    code,
    /\(\$\{[^}]*employeeHrId[^}]*\}\)/,
    "no HR code is appended to a name",
  );
}
