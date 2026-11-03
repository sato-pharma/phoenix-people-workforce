import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { directOrderCustomer360Href, findHubHoldingMarketingCustomer, marketingCustomer360Href } from "../src/lib/customer-360/hrefs.ts";
import { marketingInboxWaitingLabel, summarizeMarketingInboxWaiting } from "../src/lib/marketing-requests/inbox-waiting.ts";
import { buildProbationSalesEvidence, monthsBetween } from "../src/lib/probation/intelligence/sales-evidence.ts";
import { buildWhoElseIsOff, shouldShowWhoElseIsOff } from "../src/lib/vacation/who-else-is-off.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Four pieces of context put in front of the person deciding (owner, 2026-11-03): who else on the
 * team is off, what waits in the Marketing inbox, the territory's sales on a probation evaluation,
 * and a door from a pharmacy's name into Customer 360. Each one shows and decides nothing. The rules
 * are pure and driven here; the wiring is pinned at source level, since this suite runs with
 * production credentials and driving a page would read live people.
 */
export function runApproverContextTests() {
  // ── Who else is off ──────────────────────────────
  const range = { from: "2026-11-10", to: "2026-11-14" };
  const team = [
    { hrId: "B-1", name: "Mona Adel" },
    { hrId: "b-2", name: "Karim Said" },
    { hrId: "B-3", name: "Salma Nabil" },
  ];
  const built = buildWhoElseIsOff({
    excludeRequestId: "this-request",
    leave: [
      { day_part: "full_day", employee_hr_id: "b-1", end_date: "2026-11-30", id: "a", start_date: "2026-11-01", status: "approved" },
      { day_part: "am", employee_hr_id: "B-2", end_date: "2026-11-12", id: "b", start_date: "2026-11-12", status: "pending_manager" },
      { employee_hr_id: "B-3", end_date: "2026-11-09", id: "before", start_date: "2026-11-01", status: "approved" },
      { employee_hr_id: "B-9", end_date: "2026-11-12", id: "stranger", start_date: "2026-11-12", status: "approved" },
      { employee_hr_id: "B-3", end_date: "2026-11-12", id: "this-request", start_date: "2026-11-12", status: "approved" },
    ],
    range,
    team,
  });
  assert.equal(built.state, "ready");
  if (built.state === "ready") {
    assert.deepEqual(built.rows.map((row) => row.id), ["a", "b"], "only a teammate's overlapping leave, never this request");
    assert.equal(built.rows[0].fromDate, "2026-11-10", "a long leave reads as the days it collides with");
    assert.equal(built.rows[0].toDate, "2026-11-14");
    assert.equal(built.rows[0].isApproved, true);
    assert.equal(built.rows[1].isApproved, false, "a waiting request is not an absence, and reads differently");
    assert.equal(built.teamSize, 3, "the requester is not in the count");
    assert.deepEqual(built.peak, { count: 2, day: "2026-11-12" }, "the first day the most people are away");
    assert.ok(!("typeLabel" in built.rows[0]) && !("vacationType" in built.rows[0]), "the leave type never crosses to the screen");
  }
  const none = buildWhoElseIsOff({ excludeRequestId: "x", leave: [], range, team });
  assert.ok(none.state === "ready" && none.rows.length === 0 && none.peak === null);

  assert.equal(shouldShowWhoElseIsOff({ isOwnRequest: true, status: "pending_manager" }), false, "never on the requester's own view");
  assert.equal(shouldShowWhoElseIsOff({ isOwnRequest: false, status: "pending_hr" }), true);
  assert.equal(shouldShowWhoElseIsOff({ isOwnRequest: false, status: "approved" }), false, "a decided request has nothing to inform");

  const whoSource = stripComments(readFileSync("src/lib/vacation/who-else-is-off.ts", "utf8"));
  assert.ok(!whoSource.includes("vacation_type"), "the read does not even select the leave type: a sick day is private");
  assert.ok(!/select\(\s*"\*"/.test(whoSource), "named columns only");
  const panel = readFileSync("src/components/approvals-hub/who-else-is-off-panel.tsx", "utf8");
  assert.match(panel, /does not mean nobody is off/, "a failed read is said, never rendered as nobody");
  const detailView = readFileSync("src/components/approvals-hub/vacation-request-detail.tsx", "utf8");
  assert.ok(
    detailView.indexOf("<WhoElseIsOffPanel") < detailView.indexOf("<DecisionActions"),
    "the panel arrives before the buttons, because it is read before the decision",
  );
  for (const page of ["app/(admin)/admin/approvals/vacation/[id]/page.tsx", "app/employee-portals/approvals/vacation/[id]/page.tsx"]) {
    assert.match(readFileSync(page, "utf8"), /getWhoElseIsOffForApprovalDetail\(access, detail\)/, `${page} reads the panel`);
  }
  assert.match(readFileSync("app/(admin)/leave-management/vacation-decision/[id]/page.tsx", "utf8"), /<WhoElseIsOffPanel/, "the email link's decision page shows it too");

  // ── The Marketing inbox line ─────────────────────
  const now = "2026-11-03T10:00:00Z";
  assert.deepEqual(
    summarizeMarketingInboxWaiting({ count: 3, nowIso: now, submittedAt: ["2026-10-24T10:00:00Z", null, "2026-11-02T10:00:00Z"] }),
    { count: 3, oldestDays: 10 },
  );
  assert.equal(marketingInboxWaitingLabel({ count: 3, oldestDays: 10 }), "Marketing inbox · 3 waiting · oldest 10 days");
  assert.equal(marketingInboxWaitingLabel({ count: 1, oldestDays: 1 }), "Marketing inbox · 1 waiting · oldest 1 day");
  assert.equal(marketingInboxWaitingLabel({ count: 2, oldestDays: null }), "Marketing inbox · 2 waiting");
  assert.equal(marketingInboxWaitingLabel({ count: 0, oldestDays: null }), null, "nothing waiting, no line");
  assert.equal(marketingInboxWaitingLabel(null), "Marketing inbox · could not be read", "a failed read is never an empty inbox");
  const hub = readFileSync("app/(admin)/admin/approvals-hub/page.tsx", "utf8");
  assert.match(hub, /canAccessMarketingAdminPage\(access\.role, \{ approvalInbox: true \}\)/, "the line never links to a page that bounces the reader");
  assert.ok(!/assertPermission\([^)]*\)\.catch/.test(stripComments(hub)), "a capability flag is canAccess, never assertPermission().catch");
  assert.match(readFileSync("app/employee-portals/approvals-hub/page.tsx", "utf8"), /movedOutQueues=\{marketingInbox/, "the portal hub carries the line too");

  // ── Sales on a probation evaluation ──────────────
  assert.deepEqual(monthsBetween("2026-08-20", "2026-11-03"), ["2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(monthsBetween("2025-12-31", "2026-01-01"), ["2025-12", "2026-01"]);
  assert.deepEqual(monthsBetween("bad", "2026-01-01"), []);
  const evidence = buildProbationSalesEvidence({
    endDate: "2026-12-31",
    monthly: [
      { achievementPct: 80, hasTarget: true, month: "2026-08", sales: 800, target: 1000 },
      { achievementPct: null, hasTarget: false, month: "2026-09", sales: 500, target: 0 },
      { achievementPct: 120, hasTarget: true, month: "2026-02", sales: 9999, target: 1 },
    ],
    startDate: "2026-08-20",
    todayIso: "2026-11-03",
    unpublishedMonths: ["2026-10"],
  });
  assert.equal(evidence.state, "ready");
  if (evidence.state === "ready") {
    assert.deepEqual(evidence.months.map((row) => [row.month, row.kind]), [
      ["2026-08", "figure"],
      ["2026-09", "figure"],
      ["2026-10", "not_published"],
      ["2026-11", "no_figure"],
    ], "from the probation start to today, and never a month before the person started");
    const september = evidence.months[1];
    assert.ok(september.kind === "figure" && september.target === null, "a missing target stays missing, never a 0");
    assert.equal(evidence.achievementPct, 80, "only months carrying a target grade the total");
  }
  const ended = buildProbationSalesEvidence({ endDate: "2026-09-10", monthly: [], startDate: "2026-08-01", todayIso: "2026-11-03", unpublishedMonths: [] });
  assert.ok(ended.state === "ready" && ended.months.length === 2, "a finished probation stops at its end date");
  const salesSource = stripComments(readFileSync("src/lib/probation/intelligence/sales-evidence.ts", "utf8"));
  assert.ok(!salesSource.includes("phx_monthly_achievement"), "through Employee 360's reader, never the raw achievement table");
  assert.ok(!/\.(insert|update|upsert)\(/.test(salesSource), "display only: nothing here is written");
  for (const scoring of ["src/lib/probation/intelligence/scoring-service.ts", "src/lib/probation/intelligence/assessments.ts"]) {
    assert.ok(!readFileSync(scoring, "utf8").includes("sales-evidence"), `${scoring} must not read the sales evidence`);
  }
  assert.match(readFileSync("src/components/probation/probation-sales-evidence-panel.tsx", "utf8"), /territory/, "labelled as the territory's figure");

  // ── Customer 360 doors ───────────────────────────
  assert.equal(directOrderCustomer360Href("abc"), "/customer-360/dor_abc");
  assert.equal(marketingCustomer360Href("a b"), "/customer-360/marketing-customer/a%20b");
  const hubs = [{ id: "one", marketingCustomerIds: ["m1"] }, { id: "two", marketingCustomerIds: ["m2", "m3"] }];
  assert.equal(findHubHoldingMarketingCustomer(hubs, "m3")?.id, "two");
  assert.equal(findHubHoldingMarketingCustomer(hubs, "nope"), null);
  const resolver = readFileSync("app/(admin)/customer-360/marketing-customer/[customerId]/page.tsx", "utf8");
  assert.match(resolver, /assertPermission\(access, "sales", "read"\)/, "the resolver gates as the hub page does");
  assert.match(resolver, /loadCustomer360Report\(access\)/, "it looks in the viewer's own scoped report");
  const canOpen = readFileSync("src/lib/customer-360/open-link.ts", "utf8");
  assert.match(canOpen, /=== "employee-portal"\) return false/, "a portal reader is never offered the door");
  assert.ok(!readFileSync("app/employee-portals/direct-orders/[id]/page.tsx", "utf8").includes("customer360Href"), "the portal twin passes no link");
}
