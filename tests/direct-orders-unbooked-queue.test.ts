import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { APPROVALS_SLA_THRESHOLDS, slaTone } from "../src/components/approvals-hub/sla-thresholds.ts";
import {
  describeDirectOrderReportFilters,
  filterDirectOrderReportRows,
  parseDirectOrderReportFilters,
} from "../src/lib/direct-orders/report-filters.ts";
import type { DirectOrderReportRow } from "../src/lib/direct-orders/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Finance Manager's unbooked-direct-orders queue — badge, filter, and on-screen escalation.
 *
 * WHY THIS FILE EXISTS. Booking an approved direct order into a sales month is one person's entire
 * job (B-185; canSetDirectOrderSalesMonth admits nobody else), and until CEO approval is followed by
 * that booking the sales are in NO month's numbers — not in Source of Sales, not in a rep's
 * achievement, not in any report. Measured on production 2026-08-10: 3 approved orders worth
 * 43,925.50 EGP had been sitting unbooked for 7 days, and ZERO orders had ever been booked in the
 * module's lifetime. Nothing chased them, because direct orders is the only queue-bearing module
 * with no SLA reminder of any kind — the approved-order email fires once, at CEO approval, and then
 * the order is never mentioned again.
 *
 * The owner ruled out adding another email (2026-08-10), so the entire chase is on-screen: a sidebar
 * badge that follows him onto every page, a report filter that isolates the queue in one click, and
 * an ageing tone that gets louder instead of an escalation mail. Each of the three is silent when it
 * breaks — a badge that never lights, a filter that quietly matches everything, a tone frozen on
 * "urgent" — which is what every assertion below is for.
 */

const REPORT_FILTERS_PATH = "src/lib/direct-orders/report-filters.ts";
const SERVICE_PATH = "src/lib/direct-orders/service.ts";
const NAVIGATION_PATH = "src/config/system-navigation.ts";
const NAV_BADGE_PATH = "src/components/layout/nav-badge.tsx";
const BADGE_STORE_PATH = "src/lib/nav-badge-store.ts";
const BADGE_COUNTS_ROUTE_PATH = "src/lib/approvals-hub/badge-counts-payload.ts";
const DASHBOARD_PATH = "src/components/admin/finance-command-center.tsx";
const DASHBOARD_SERVICE_PATH = "src/lib/finance/command-center.ts";
// Under (desks)/ since 2026-08-12 — a ROUTE GROUP, so the URL is unchanged and only the file
// moved. The group scopes the persistent Direct Orders tab strip to the ten desks.
const REPORT_PAGE_PATH = "app/(admin)/admin/direct-orders/(desks)/report/page.tsx";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Minimal row — only the four fields the filter actually reads. */
function row(overrides: Partial<DirectOrderReportRow>): DirectOrderReportRow {
  return {
    productName: "Lacto Advanced 1",
    requesterName: "Test Requester",
    salesMonth: null,
    salesValue: 1000,
    status: "approved",
    ...overrides,
  } as DirectOrderReportRow;
}

export function runDirectOrdersUnbookedQueueTests() {
  // ── 1. The escalation threshold ──────────────────────────────────────────────────────────────
  // Reuses slaTone rather than growing a second idea of "late" — but a threshold is only a guard if
  // its boundaries are pinned, and an off-by-one here is invisible: the tile simply stays the wrong
  // colour. 5 days is measured against the MONTH BOUNDARY, not a service target: an unbooked order
  // is uncounted, and the real damage is it drifting past a month end into a period that may already
  // be closed.
  assert.equal(APPROVALS_SLA_THRESHOLDS.directOrderMonth, 5, "the unbooked-month threshold is 5 days");
  assert.equal(slaTone(0, APPROVALS_SLA_THRESHOLDS.directOrderMonth), "none", "booked same day is not late");
  assert.equal(slaTone(3, APPROVALS_SLA_THRESHOLDS.directOrderMonth), "none", "3 days is still routine turnaround");
  assert.equal(slaTone(4, APPROVALS_SLA_THRESHOLDS.directOrderMonth), "due", "day 4 must warn BEFORE the threshold, not on it");
  assert.equal(slaTone(5, APPROVALS_SLA_THRESHOLDS.directOrderMonth), "overdue", "at the threshold it is overdue");
  assert.equal(slaTone(7, APPROVALS_SLA_THRESHOLDS.directOrderMonth), "overdue", "the real 2026-08-10 backlog (7 days) is overdue");

  // ── 2. The filter selects exactly the unbooked slice ─────────────────────────────────────────
  const population = [
    row({ salesMonth: null, status: "approved" }),            // the queue
    row({ salesMonth: "2026-08", status: "approved" }),       // already booked
    row({ salesMonth: null, status: "pending_approval" }),    // not his yet
    row({ salesMonth: null, status: "rejected" }),            // never his
    row({ salesMonth: null, status: "held" }),                // parked outside the chain
  ];

  const unbooked = filterDirectOrderReportRows(population, { search: "", statuses: [], unbookedOnly: true });
  assert.equal(unbooked.length, 1, "only APPROVED orders with no sales month are the Finance queue");
  assert.equal(unbooked[0]?.status, "approved");
  assert.equal(unbooked[0]?.salesMonth, null);

  // The inverse, and the failure that would matter most: a filter that silently matches everything
  // looks like it works right up until someone books a month against the wrong order.
  const unfiltered = filterDirectOrderReportRows(population, { search: "", statuses: [], unbookedOnly: false });
  assert.equal(unfiltered.length, 5, "unbookedOnly:false must not narrow anything");

  // ── 3. It composes with the other two filters, it does not replace them ──────────────────────
  // "Awaiting month" narrows on a different axis than status, so both must apply (AND). If it ever
  // short-circuits the status chips, a reader who clicked both gets a WIDER slice than they asked
  // for — the exact direction report-filters.ts's own header warns must never happen.
  const composed = filterDirectOrderReportRows(population, {
    search: "",
    statuses: ["approved"],
    unbookedOnly: true,
  });
  assert.equal(composed.length, 1, "unbookedOnly AND status compose");
  assert.equal(
    filterDirectOrderReportRows(population, { search: "", statuses: ["held"], unbookedOnly: true }).length,
    0,
    "an impossible combination must narrow to nothing, never fall back to one side",
  );
  assert.equal(
    filterDirectOrderReportRows(
      [row({ productName: "Guamusin", salesMonth: null }), row({ productName: "Royafloxacin", salesMonth: null })],
      { search: "guamusin", statuses: [], unbookedOnly: true },
    ).length,
    1,
    "unbookedOnly AND search compose, so hunting one order inside the queue works",
  );

  // ── 4. The export cannot be widened by a tampered body ───────────────────────────────────────
  // parseDirectOrderReportFilters guards the XLSX route and the public share-link feed. Every
  // unrecognised value must fall to the NARROWER reading; for this flag that is `false`, and a
  // truthy-coercing parse would let the string "false" flip the export to a slice nobody chose.
  assert.equal(parseDirectOrderReportFilters({}).unbookedOnly, false, "absent means false");
  assert.equal(parseDirectOrderReportFilters({ unbookedOnly: true }).unbookedOnly, true);
  for (const hostile of ["true", "1", 1, {}, [], "false", "0", null]) {
    assert.equal(
      parseDirectOrderReportFilters({ unbookedOnly: hostile }).unbookedOnly,
      false,
      `only a real boolean true may set the flag — ${JSON.stringify(hostile)} must not`,
    );
  }

  // A filtered workbook gets forwarded on its own, so it has to say which slice it is.
  const stamp = describeDirectOrderReportFilters({ search: "", statuses: [], unbookedOnly: true });
  assert.ok(stamp, "an unbooked-only export must carry a filter stamp");
  assert.match(String(stamp), /Awaiting a sales month/, "the stamp names the slice in words, not a flag name");
  assert.equal(
    describeDirectOrderReportFilters({ search: "", statuses: [], unbookedOnly: false }),
    null,
    "an unfiltered export must stay unstamped",
  );

  // ── 5. The badge is wired through ALL FOUR lists ─────────────────────────────────────────────
  // This is the repo's documented failure mode, not a hypothetical: the nav row, the sidebar switch,
  // the client batch map and the server batch response are four separate lists, and a badge missing
  // from any ONE of them renders nothing at all with no error anywhere. The same class of break is
  // what tests/ceo-marketing-approval-inbox.test.ts exists for on the marketing side.
  assert.match(
    read(NAVIGATION_PATH),
    // [^\n]* not [^}]*: the row carries a nested `permissions: [{ ... }]` between the two anchors.
    /href: "\/admin\/direct-orders"[^\n]*navBadge: "direct-orders-needs-action"/,
    "the Direct Orders sidebar row must carry the needs-action badge",
  );
  assert.match(
    read(NAV_BADGE_PATH),
    /case "direct-orders-needs-action":[\s\S]{0,260}\/api\/direct-orders\/needs-action-count/,
    "the shared badge switch must resolve the new key to its endpoint",
  );
  assert.match(
    read(BADGE_STORE_PATH),
    /"\/api\/direct-orders\/needs-action-count": "directOrdersNeedsAction"/,
    "the badge must ride the batched poll, not open its own 30s request",
  );
  // The row MOVED on 2026-08-10: /sales/direct-orders-tools was retired and the module's five nav
  // entries collapsed into one "Direct Orders" row. A single row carries a single badge, so the
  // unbooked count is now SUMMED into `direct-orders-needs-action` alongside the approval count.
  // The four-list rule is unchanged and still swept; it just follows the badge the row now carries,
  // and the assertion below keeps the unbooked half reachable inside it.
  const badgeCounts = read(BADGE_COUNTS_ROUTE_PATH);
  assert.match(badgeCounts, /getDirectOrderUnbookedBadge\(access\)/, "the batched route must still fetch the unbooked count");
  assert.match(
    badgeCounts,
    /directOrdersNeedsAction:[\s\S]{0,400}directOrdersUnbooked\.value\.count/,
    "THE UNBOOKED COUNT MUST BE SUMMED INTO THE ONE ROW'S BADGE: drop it and the Finance Manager's only ambient chaser goes invisible, which is the whole reason that badge exists",
  );
  assert.match(
    badgeCounts,
    /directOrdersUnbooked:[\s\S]{0,140}\{ count: 0, overdue: false \}/,
    "a failing unbooked lookup must fall back to a zero slot, never blank the other badges",
  );

  // ── 6. The badge is invisible to everyone who cannot clear it ────────────────────────────────
  // The Direct Orders nav row is permission-gated only (`direct_orders:read`), so SFE, the CEO and
  // every sales manager reach it too. A red count none of them can ever clear is how people learn to
  // ignore badges — and this gate is the only thing stopping it, since the row itself cannot be
  // narrowed without hiding the module from the roles that legitimately read it.
  const service = read(SERVICE_PATH);
  // The badge function, bounded by the next top-level declaration — a real end. The three checks
  // below took 700, 700 and 1200 bytes of it. The function is 1,278 bytes of code, so the 1200 one
  // — a `doesNotMatch` — was already 78 bytes short, and a `doesNotMatch` that runs out of text
  // PASSES rather than failing.
  const badgeAt = service.indexOf("export async function getDirectOrderUnbookedBadge");
  const badgeRest = service.slice(badgeAt + 1);
  const badgeNext = badgeRest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
  const badgeFn = service.slice(badgeAt, badgeNext >= 0 ? badgeAt + 1 + badgeNext : service.length);
  assert.ok(badgeFn.length > 0, "getDirectOrderUnbookedBadge must exist");
  assert.match(
    badgeFn,
    /if \(!canSetDirectOrderSalesMonth\(access\)\) return \{ count: 0, overdue: false \};/,
    "a viewer who cannot book a sales month must always see a zero count",
  );
  assert.match(
    badgeFn,
    /assertPermission\(access, "direct_orders", "read"\)/,
    "the badge must assert its own permission — it is reachable as a bare endpoint too",
  );
  // Cheapness is a correctness property here: NavBadge polls every 30s. Its sibling on the same
  // row, countDirectOrderAwaitingFast, is held to the same standard by
  // tests/direct-orders-badge-fast-path.test.ts — the slow countDirectOrderAwaiting that used to
  // load the whole workspace for one integer was deleted on 2026-08-11.
  assert.doesNotMatch(
    badgeFn,
    /getDirectOrderWorkspaceData/,
    "the badge must not load the whole workspace on a 30-second poll",
  );

  // ── 7. The queue row lands him on the filtered report, not on all 24 rows ────────────────────
  // Stripped: every dashboard assertion below targets CODE, and the comments in that file quote the
  // removed tiles and the old flat-rose test by name in order to explain them.
  const dashboard = stripComments(read(DASHBOARD_PATH));
  assert.match(
    dashboard,
    /href="\/admin\/direct-orders\/report\?unbooked=1"/,
    "the dashboard queue row must deep-link to the pre-filtered report",
  );
  assert.match(
    read(REPORT_PAGE_PATH),
    /=== "1"/,
    "the report page must read ?unbooked=1 server-side",
  );
  assert.match(
    read(REPORT_FILTERS_PATH),
    /showsAwaitingFinanceMonth\(row\.status, row\.salesMonth\)/,
    "the filter must reuse the shared predicate, not grow a fourth copy of it",
  );

  // ── 8. Ageing is graduated, and all three surfaces agree ─────────────────────────────────────
  // Before this change every surface went rose the moment the count passed zero, so a queue cleared
  // the same afternoon looked exactly as alarming as one seven days old. One helper, three callers —
  // if they ever diverge, the tile and the row disagree about the same number on the same screen.
  assert.match(dashboard, /function unbookedTone\(/, "a single shared tone helper must exist");
  assert.equal(
    (dashboard.match(/unbookedTone\(data\.directOrders\.awaitingCount, data\.directOrders\.awaitingOldest\)/g) ?? []).length,
    3,
    "the metric tile, the pipeline stat and the oldest-unbooked stat must all use the shared tone",
  );
  assert.match(
    dashboard,
    /tone=\{unbookedQueueTone\(data\.directOrders\.awaitingCount, data\.directOrders\.awaitingOldest\)\}/,
    "the queue row must use the shared tone too",
  );
  assert.doesNotMatch(
    dashboard,
    /tone=\{data\.directOrders\.awaitingCount > 0 \? "rose" : /,
    "no surface may go back to a flat count>0 ? rose test",
  );

  // ── 9. The dead receivables tiles are gone and stay gone ─────────────────────────────────────
  // "Collected" and "Still outstanding" read paid_amount / remaining_amount, which NOTHING in the
  // codebase writes — no screen, no route, no service. They were permanently EGP 0. The owner ruled
  // out collection tracking on 2026-08-10, so the tiles went; this asserts nobody restores them
  // under the page's own "render the zero, tomorrow it fills" rule, which does not apply to a stage
  // that has no tomorrow.
  for (const dead of ["Collected", "Still outstanding"]) {
    assert.doesNotMatch(
      dashboard,
      new RegExp(`label="${dead}"`),
      `the ${dead} tile must not come back while nothing writes a payment`,
    );
  }
  assert.doesNotMatch(dashboard, /collected · paid/, "the pipeline description must not promise stages that were removed");
  for (const field of ["collectedCount", "paidTotal", "remainingTotal"]) {
    assert.doesNotMatch(
      stripComments(read(DASHBOARD_SERVICE_PATH)),
      new RegExp(`\\b${field}\\b`),
      `${field} must not be modelled in the payload while nothing can populate it`,
    );
  }

  // ── 10. The portal report must not open on the unbooked filter ───────────────────────────────
  // No portal role can book a sales month, so the chip is admin-shell only.
  //
  // The rule MOVED on 2026-08-10 without changing. It used to be enforced by the portal having its
  // own report component; that twin was retired onto the shared DirectOrderReportWorkspace, so what
  // keeps the filter off for the portal is now the PAGE declining to pass `initialUnbookedOnly`
  // (the prop defaults to false). Asserting on the component would prove nothing — it is the same
  // component the Finance Manager uses WITH the chip.
  const portalReportPage = readFileSync(
    new URL("../app/employee-portals/direct-orders/report/page.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    portalReportPage,
    /initialUnbookedOnly/,
    "the portal report page must not pass initialUnbookedOnly — no portal role can clear that queue",
  );
}
