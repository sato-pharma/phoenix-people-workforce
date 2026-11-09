import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { marketingRoiPageItems } from "../src/config/system-navigation.ts";
import {
  buildCeoApprovalRows,
  cairoDayStartIso,
  canViewMarketingCeoApprovals,
  ceoApprovalsWindow,
  resolveCeoApprovalsRange,
  summarizeCeoApprovals,
  type CeoApprovalRequestInput,
  type CeoApprovalStepInput,
} from "../src/lib/marketing-requests/ceo-approvals.ts";

// CEO Approvals (owner, 2026-11-08): every marketing request the CEO approved between two Cairo
// dates, with whether Finance has executed it, every row ticked by default and the totals following
// the ticks.

const TODAY = "2026-11-08";

function step(requestId: string, overrides: Partial<CeoApprovalStepInput> = {}): CeoApprovalStepInput {
  return {
    decisionAt: null,
    decisionByHrId: null,
    executedAt: null,
    isCc: false,
    requestId,
    sequence: 5,
    status: "pending",
    stepCode: "ceo_approval",
    stepName: "CEO Approval",
    ...overrides,
  };
}

function ceoApproved(requestId: string, decisionAt: string, decisionByHrId = "AA"): CeoApprovalStepInput {
  return step(requestId, { decisionAt, decisionByHrId, status: "approved" });
}

function financeStep(requestId: string, overrides: Partial<CeoApprovalStepInput> = {}): CeoApprovalStepInput {
  return step(requestId, { sequence: 6, stepCode: "finance_execution", stepName: "Finance Execution", status: "current", ...overrides });
}

function request(id: string, overrides: Partial<CeoApprovalRequestInput> = {}): CeoApprovalRequestInput {
  return {
    customerId: `customer-${id}`,
    customerName: `Customer ${id}`,
    estimatedCost: 1000,
    href: `/marketing-requests/${id}`,
    id,
    lineName: "Pedia",
    payDate: "2026-11-20",
    requestCode: `MKT-REQ-${id}`,
    requesterHrId: "B-154",
    requesterName: "Nermeen Salah",
    requestType: "Deal",
    status: "pending_approval",
    ...overrides,
  };
}

const deciders = new Map([
  ["aa", { isCeo: true, name: "Dr Anwar Gaweesh" }],
  ["b-10", { isCeo: false, name: "Omar Gawish" }],
  ["b-185", { isCeo: false, name: "Ahmed El Maraghy" }],
]);

export async function runMarketingCeoApprovalsTests() {
  // ── Who may read it ─────────────────────────────────────────────────────────────────────────────
  for (const role of ["Marketing Manager", "CEO", "Super Admin"]) {
    assert.equal(canViewMarketingCeoApprovals(role), true, `${role} is one of the report's three readers`);
  }
  for (const role of ["SFE Manager", "Product Manager", "Finance Manager", "Medical Rep", "District Manager", "Employee", null, undefined, ""]) {
    assert.equal(canViewMarketingCeoApprovals(role), false, `${String(role)} must not read CEO Approvals`);
  }

  // ── The two dates ───────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(resolveCeoApprovalsRange({}, TODAY), { from: "2026-11-01", to: "2026-11-08" }, "no dates: this Cairo month so far");
  assert.deepEqual(
    resolveCeoApprovalsRange({ from: "2026-10-01", to: "2026-10-31" }, TODAY),
    { from: "2026-10-01", to: "2026-10-31" },
  );
  assert.deepEqual(
    resolveCeoApprovalsRange({ from: "2026-11-05", to: "2026-11-01" }, TODAY),
    { from: "2026-11-01", to: "2026-11-05" },
    "dates typed the wrong way round are swapped, never answered with an empty table",
  );
  assert.deepEqual(
    resolveCeoApprovalsRange({ from: "2026-02-30", to: "nonsense" }, TODAY),
    { from: "2026-11-01", to: "2026-11-08" },
    "an impossible or unreadable date falls back",
  );
  assert.deepEqual(resolveCeoApprovalsRange({ from: ["2026-11-02", "x"] }, TODAY).from, "2026-11-02");

  // Cairo midnight is UTC+2 in November and UTC+3 in summer; the window ends at the next Cairo midnight.
  assert.equal(cairoDayStartIso("2026-11-01"), "2026-10-31T22:00:00.000Z");
  assert.equal(cairoDayStartIso("2026-07-01"), "2026-06-30T21:00:00.000Z");
  assert.deepEqual(ceoApprovalsWindow({ from: "2026-11-01", to: "2026-11-30" }), {
    endIso: "2026-11-30T22:00:00.000Z",
    startIso: "2026-10-31T22:00:00.000Z",
  });

  // ── The rows ────────────────────────────────────────────────────────────────────────────────────
  const rows = buildCeoApprovalRows({
    ceoApprovals: [
      ceoApproved("paid", "2026-11-01T09:03:00.000Z"),
      ceoApproved("waiting", "2026-11-03T08:38:00.000Z"),
      ceoApproved("late", "2026-11-04T13:32:00.000Z"),
      ceoApproved("proxy", "2026-11-05T10:00:00.000Z", "B-10"),
      ceoApproved("rejected-later", "2026-11-06T10:00:00.000Z"),
      // Approved twice (returned and resubmitted): the newest approval is the one listed.
      ceoApproved("twice", "2026-11-02T10:00:00.000Z"),
      ceoApproved("twice", "2026-11-07T10:00:00.000Z"),
      // A cc copy or another rung is never "approved by the CEO".
      step("cc", { decisionAt: "2026-11-02T10:00:00.000Z", isCc: true, status: "approved" }),
      step("manager", { decisionAt: "2026-11-02T10:00:00.000Z", status: "approved", stepCode: "manager_chain" }),
    ],
    deciders,
    requestsById: new Map(
      [
        request("paid", { estimatedCost: 10000, payDate: "2026-11-04", status: "active" }),
        request("waiting", { estimatedCost: 5000, payDate: "2026-11-12" }),
        request("late", { estimatedCost: 20000, payDate: "2026-10-15" }),
        request("proxy", { estimatedCost: 3000, payDate: "2026-11-01", status: "finance_hold" }),
        request("rejected-later", { estimatedCost: 700, payDate: "2026-10-01", status: "rejected" }),
        request("twice", { estimatedCost: 1500 }),
        request("cc"),
        request("manager"),
      ].map((row) => [row.id, row]),
    ),
    steps: [
      financeStep("paid", { decisionAt: "2026-11-03T10:33:00.000Z", decisionByHrId: "B-185", executedAt: "2026-11-03T10:33:00.000Z", status: "approved" }),
      financeStep("waiting"),
      financeStep("late"),
      financeStep("proxy", { status: "pending" }),
      financeStep("rejected-later", { status: "skipped" }),
      step("twice", { sequence: 6, status: "current", stepCode: "marketing_review", stepName: "Marketing Review" }),
    ],
    todayCairo: TODAY,
  });

  assert.deepEqual(
    rows.map((row) => row.requestId),
    ["paid", "waiting", "late", "proxy", "rejected-later", "twice"],
    "one row per request, by approval time; cc copies and other rungs are left out",
  );
  const byId = new Map(rows.map((row) => [row.requestId, row]));

  const paid = byId.get("paid")!;
  assert.equal(paid.statusLabel, "Active", "the Key Data tab's column N, word for word");
  assert.equal(paid.financeState, "executed");
  assert.equal(paid.executedByName, "Ahmed El Maraghy");
  assert.equal(paid.executedAtIso, "2026-11-03T10:33:00.000Z");
  assert.equal(paid.payDateOverdue, false, "an executed request is never late, whatever its pay date");
  assert.equal(paid.approvedOnBehalfBy, null, "the CEO's own approval names nobody else");

  const waiting = byId.get("waiting")!;
  assert.equal(waiting.statusLabel, "Pending approval");
  assert.equal(waiting.financeState, "waiting_finance");
  assert.equal(waiting.financeLabel, "Waiting for Finance");
  assert.equal(waiting.payDateOverdue, false, "a pay date still ahead is not late");

  assert.equal(byId.get("late")!.payDateOverdue, true, "a passed pay date with Finance still open is flagged");

  const proxy = byId.get("proxy")!;
  assert.equal(proxy.approvedOnBehalfBy, "Omar Gawish", "someone pressing on the CEO's rung is named");
  assert.equal(proxy.financeState, "held");
  assert.equal(proxy.payDateOverdue, true);

  const rejected = byId.get("rejected-later")!;
  assert.equal(rejected.financeState, "closed_out");
  assert.equal(rejected.statusLabel, "Rejected");
  assert.equal(rejected.payDateOverdue, false, "a request that left the chain owes nothing");

  const twice = byId.get("twice")!;
  assert.equal(twice.approvedAtIso, "2026-11-07T10:00:00.000Z");
  assert.equal(twice.financeLabel, "Waiting for Marketing Review");

  // ── The totals follow the ticks ─────────────────────────────────────────────────────────────────
  const all = summarizeCeoApprovals(rows);
  assert.deepEqual(all, {
    carriedOverCount: 0,
    count: 6,
    executedCount: 1,
    executedValue: 10000,
    overdueCount: 2,
    totalValue: 40200,
    waitingCount: 4,
    waitingValue: 29500,
  });
  assert.deepEqual(summarizeCeoApprovals(rows, new Set(rows.map((row) => row.requestId))), all, "every row ticked is the whole list");
  const someTicked = summarizeCeoApprovals(rows, new Set(["paid", "late"]));
  assert.equal(someTicked.count, 2);
  assert.equal(someTicked.totalValue, 30000, "an unticked row leaves the total");
  assert.equal(someTicked.waitingValue, 20000);
  assert.equal(summarizeCeoApprovals(rows, new Set()).totalValue, 0);

  assert.ok(rows.every((row) => row.listedAs === "approved_in_period"), "without a period every row is the period's own");

  // ── Hossam's week (owner, 2026-11-08) ──────────────────────────────────────────────────────────
  // "Approved requests 8th Nov to 15th Nov" listed 12 requests; Dr Anwar approved 3 in those dates and
  // the other 9 earlier, all still waiting for Finance. A period lists both, each saying which.
  const week = ceoApprovalsWindow({ from: "2026-11-08", to: "2026-11-15" });
  const weekRows = buildCeoApprovalRows({
    ceoApprovals: [
      ceoApproved("in-week", "2026-11-08T08:54:00.000Z"),
      ceoApproved("carried", "2026-11-03T10:20:00.000Z"),
      ceoApproved("carried-hold", "2026-10-27T07:18:00.000Z"),
      ceoApproved("carried-paid", "2026-11-01T09:05:00.000Z"),
      ceoApproved("carried-rejected", "2026-11-02T09:05:00.000Z"),
      ceoApproved("carried-back-in-chain", "2026-11-02T09:05:00.000Z"),
      // Approved before the week AND again inside it: the week's own approval wins.
      ceoApproved("re-approved", "2026-11-01T09:00:00.000Z"),
      ceoApproved("re-approved", "2026-11-09T09:00:00.000Z"),
      // An approval after the week has ended is not this week's.
      ceoApproved("after-week", "2026-11-15T22:00:00.000Z"),
      // Cairo midnight of 8 Nov is 22:00 UTC on 7 Nov: one minute before is carried over, the minute itself is in the week.
      ceoApproved("edge-before", "2026-11-07T21:59:00.000Z"),
      ceoApproved("edge-start", "2026-11-07T22:00:00.000Z"),
    ],
    deciders,
    period: week,
    requestsById: new Map(
      [
        request("in-week", { estimatedCost: 1500 }),
        request("carried", { estimatedCost: 1000 }),
        request("carried-hold", { estimatedCost: 5000, status: "finance_hold" }),
        request("carried-paid", { estimatedCost: 3000, status: "active" }),
        request("carried-rejected", { estimatedCost: 700, status: "rejected" }),
        request("carried-back-in-chain", { estimatedCost: 900 }),
        request("re-approved", { estimatedCost: 2000 }),
        request("after-week", { estimatedCost: 800 }),
        request("edge-before", { estimatedCost: 100 }),
        request("edge-start", { estimatedCost: 200 }),
      ].map((row) => [row.id, row]),
    ),
    steps: [
      financeStep("in-week"),
      financeStep("carried"),
      financeStep("carried-hold", { status: "pending" }),
      financeStep("carried-paid", { decisionAt: "2026-11-03T10:33:00.000Z", decisionByHrId: "B-185", status: "approved" }),
      financeStep("carried-rejected", { status: "skipped" }),
      step("carried-back-in-chain", { sequence: 4, status: "current", stepCode: "marketing_review", stepName: "Marketing Review" }),
      financeStep("re-approved"),
      financeStep("after-week"),
      financeStep("edge-before"),
      financeStep("edge-start"),
    ],
    todayCairo: TODAY,
  });
  const listed = Object.fromEntries(weekRows.map((row) => [row.requestId, row.listedAs]));
  assert.deepEqual(
    listed,
    {
      carried: "carried_over",
      "carried-hold": "carried_over",
      "edge-before": "carried_over",
      "edge-start": "approved_in_period",
      "in-week": "approved_in_period",
      "re-approved": "approved_in_period",
    },
    "the week's approvals plus every earlier one Finance still owes (waiting or on hold); paid, rejected, back-in-chain and after-the-week ones are left out",
  );
  assert.deepEqual(
    weekRows.map((row) => row.requestId),
    ["carried-hold", "carried", "edge-before", "edge-start", "in-week", "re-approved"],
    "carried-over rows sit with the rest, oldest approval first",
  );
  assert.equal(summarizeCeoApprovals(weekRows).carriedOverCount, 3);
  assert.equal(summarizeCeoApprovals(weekRows, new Set(["in-week", "carried"])).carriedOverCount, 1, "the count follows the ticks");

  const reportSource = readFileSync(new URL("../src/components/marketing-requests/marketing-ceo-approvals-report.tsx", import.meta.url), "utf8");
  assert.match(reportSource, /scope="col">Listed as<\/th>/, "the desktop table has the Listed as column");
  assert.equal((reportSource.match(/<ListedAsCell /g) ?? []).length, 2, "the Listed as cell is on the desktop row AND the mobile card");
  const serviceSource = readFileSync(new URL("../src/lib/marketing-requests/ceo-approvals-service.ts", import.meta.url), "utf8");
  assert.match(serviceSource, /period: window,/, "the service hands the period to the row builder, or nothing is ever carried over");

  // ── Reachable: the portal row, the admin card, the twin, and rows ticked by default ─────────────
  const card = marketingRoiPageItems.find((item) => item.href === "/admin/marketing-requests/ceo-approvals");
  assert.ok(card, "the Marketing & ROI hub carries a CEO Approvals card");
  assert.deepEqual([...(card.roles ?? [])].sort(), ["CEO", "Marketing Manager", "Super Admin"]);

  const navigation = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");
  assert.match(navigation, /href: "\/employee-portals\/marketing-requests\/ceo-approvals"/, "the Marketing Manager's portal sidebar row");
  const twins = readFileSync(new URL("../src/lib/navigation/portal-twins.ts", import.meta.url), "utf8");
  assert.match(twins, /from: "\/admin\/marketing-requests\/ceo-approvals", to: "\/employee-portals\/marketing-requests\/ceo-approvals"/);

  const component = readFileSync(new URL("../src/components/marketing-requests/marketing-ceo-approvals-report.tsx", import.meta.url), "utf8");
  assert.match(component, /useState<Set<string>>\(\(\) => new Set\(allIds\)\)/, "every row starts ticked");
  assert.match(component, /summarizeCeoApprovals\(rows, selected\)/, "the tiles and footer read the ticked set");

  // "Show report" must never look dead (owner, 2026-11-09: "when I filter and press, nothing happens").
  // The date inputs carry no min/max — they made the browser refuse a To date picked before the From
  // date with a bubble that vanishes in seconds — and the press is a transition that says "Loading…"
  // until the new range arrives. Reversed dates are swapped by the resolver, pinned here too.
  {
    const component = readFileSync(new URL("../src/components/marketing-requests/marketing-ceo-approvals-report.tsx", import.meta.url), "utf8");
    const form = component.slice(component.indexOf("function RangeForm("), component.indexOf("export function MarketingCeoApprovalsReport("));
    assert.ok(form.length > 0, "the range form is found");
    assert.doesNotMatch(form, /\b(min|max)=\{/, "the date inputs carry no min/max that silently blocks the press");
    assert.match(form, /useTransition\(\)/, "the press runs as a transition");
    assert.match(form, /disabled=\{pending\}/, "the button is disabled while the new range loads");
    assert.match(form, /pending \? "Loading…" : "Show report"/, "the button says it is loading");
    assert.match(form, /router\.refresh\(\)/, "the same dates again re-read the page");
    assert.match(component, /aria-busy=\{loading\}/, "the report dims while the new range loads");
    assert.deepEqual(resolveCeoApprovalsRange({ from: "2026-10-31", to: "2026-10-01" }, TODAY), { from: "2026-10-01", to: "2026-10-31" });
  }
}
