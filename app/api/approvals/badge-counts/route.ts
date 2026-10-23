import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { countAwaitingMyActionItems } from "@/lib/action-center/service";
import {
  badgeCountsAreCacheable,
  badgeCountsViewerKey,
  serveViewerBadgeCounts,
} from "@/lib/approvals-hub/badge-counts-cache";
import { recordTiming } from "@/lib/observability/timings";
import { countDirectOrderAwaitingFast, getDirectOrderUnbookedBadge } from "@/lib/direct-orders/service";
import { countDirectOrderPendingValidations } from "@/lib/direct-orders/pharmacy-validation";
import { getMarketAwarenessDecisionBadge } from "@/lib/market-awareness/service";
import { getMarketingApproverBadge } from "@/lib/marketing-requests/service";
import { countOpenDeductionsDisputes } from "@/lib/deductions/comments";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions";
import { listPendingPrivateCalendarDataDisputes } from "@/lib/private-calendar/disputes";
import {
  getExcuseAwaitingBadge,
  getPlanAwaitingBadge,
  getVacationAwaitingBadge,
} from "@/lib/approvals-hub/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Batched sidebar badge counts — ONE poll replaces the separate 30s polls of
// /api/approvals/plan/pending-count, /api/approvals/vacation/pending-count,
// /api/approvals/excuse/pending-count, /api/approvals-hub/pending-count,
// /api/marketing-requests/pending-count and /api/market-awareness/pending-count (which stay in
// place untouched for any other consumer). Each domain runs under EXACTLY the same permission
// guard as its dedicated endpoint, its dataset is fetched ONCE (the per-domain endpoints fetch the
// vacation/excuse/plan responder dataset twice per poll — once for the count, once for
// the overdue flag), and a failing domain falls back to the same {count: 0} shape its
// dedicated endpoint returns — one broken domain never blanks the other badges.
//
// Remembered per viewer for 20 s (2026-10-23, every page change under 1 second): production that
// day measured 141 calls in about 27 minutes at about 1.6 s each, mostly the same person asking
// again within seconds from a second tab or a page change. serveViewerBadgeCounts keys the memory
// on the viewer's WHOLE access context, so no count is ever shared between viewers, joins two tabs
// asking together onto one read, and stores a response only when every domain answered or was
// refused by a permission guard — never one with a failed read in it. The reads below and every
// guard on them are unchanged; only how often one viewer pays for them is.
export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const access = await resolveAccessContext(request);
    const served = await serveViewerBadgeCounts(badgeCountsViewerKey(access), async () => {
      const settled = await Promise.allSettled([
        (async () => {
          await assertPermission(access, "weekly_plans", "read");
          return getPlanAwaitingBadge(access);
        })(),
        (async () => {
          await assertPermission(access, "leave", "read");
          return getVacationAwaitingBadge(access);
        })(),
        (async () => {
          await assertPermission(access, "leave", "read");
          return getExcuseAwaitingBadge(access);
        })(),
        (async () => {
          await assertPermission(access, "leave", "read");
          const audience = resolveNavigationMode(access) === "employee-portal" ? "portal" : "admin";
          // Counts only the sources the inbox keeps — see countAwaitingMyActionItems.
          return { count: await countAwaitingMyActionItems(access, audience) };
        })(),
        // Direct Orders Approvals was the only Approvals Hub tab with no badge, even though
        // countDirectOrderAwaiting already existed (and had zero consumers). It is scoped to the
        // caller's own rung via viewerCanActOnStep and asserts direct_orders:read itself, so a role
        // without the resource falls back to {count: 0} exactly like every other domain here.
        (async () => {
          await assertPermission(access, "direct_orders", "read");
          return { count: await countDirectOrderAwaitingFast(access) };
        })(),
        // The Finance Manager's unbooked queue — approved orders with no sales month. Its own slot,
        // never folded into `directOrders` above: that one is "waiting on your approval rung", this is
        // "already approved and waiting on Finance", and the one person who owns this holds no
        // approval rung at all. It asserts direct_orders:read itself and returns 0 to anyone who
        // cannot book a month, so every other role sharing the Direct Orders nav row stays unbadged.
        getDirectOrderUnbookedBadge(access),
        // Pharmacy claims awaiting confirmation — the third queue the workspace inbox counts. A count,
        // not a list: it rides the same 30s poll. Returns 0 to anyone who cannot work the desk.
        countDirectOrderPendingValidations(access),
        // Marketing Approval Inbox. No assertPermission: marketing has no permission resource, and
        // getMarketingApproverBadge is scoped entirely by the caller's own `assigned_hr_id` (same gate
        // as /api/marketing-requests/inbox), so it can only ever count the caller's own rung. A role
        // with no marketing step assigned to it simply gets 0.
        getMarketingApproverBadge(access),
        // Awareness Approvals. It asserts market_awareness:read itself and then narrows to the
        // decisions that are actually the caller's, so every role that is not in an awareness chain
        // — which is most of them — settles at 0 without a refusal reaching this response.
        getMarketAwarenessDecisionBadge(access),
        // Calendar Disputes, its own inbox since 2026-10-08. No assertPermission: the list asserts
        // Super Admin for itself (assertDisputeDecisionActor), so every other role settles at 0
        // without a refusal reaching this response — the same shape as marketing above.
        (async () => ({ count: (await listPendingPrivateCalendarDataDisputes(access)).length }))(),
        // Deduction Disputes, its own inbox since 2026-10-08. assertDeductionsReadActor on top of the
        // matrix: `deductions:read` alone is held by seats that may see only their OWN line, and the
        // count is a company-wide read like every other one that helper guards. Anyone else settles
        // at 0 here without a refusal reaching the poll.
        (async () => {
          assertDeductionsReadActor(access);
          return { count: await countOpenDeductionsDisputes() };
        })(),
      ]);
      const [plan, vacation, excuse, hub, directOrders, directOrdersUnbooked, directOrderValidations, marketing, marketAwareness, calendarDisputes, deductionDisputes] = settled;
      return {
        // A refusal is the viewer's standing and reads the same every time; any other rejection, or a
        // domain reporting `available: false`, keeps this response out of the 20 s memory.
        cacheable: badgeCountsAreCacheable(settled, isForbiddenError),
        body: {
          plan: plan.status === "fulfilled" ? plan.value : { count: 0, overdue: false },
          vacation: vacation.status === "fulfilled" ? vacation.value : { count: 0, overdue: false },
          excuse: excuse.status === "fulfilled" ? excuse.value : { count: 0, overdue: false },
          hub: hub.status === "fulfilled" ? hub.value : { count: 0 },
          directOrders: directOrders.status === "fulfilled" ? directOrders.value : { count: 0 },
          directOrdersUnbooked:
            directOrdersUnbooked.status === "fulfilled" ? directOrdersUnbooked.value : { count: 0, overdue: false },
          // The single Direct Orders row's badge. DERIVED from the two slots above rather than
          // fetched: the sets are provably disjoint (an order is either still in the chain or through
          // it and waiting on Finance), and both halves already returned 0 to anyone who cannot clear
          // them — so the sum stays a number the reader can act on, at zero extra query cost.
          directOrdersNeedsAction: {
            count:
              (directOrders.status === "fulfilled" ? directOrders.value.count : 0) +
              (directOrdersUnbooked.status === "fulfilled" ? directOrdersUnbooked.value.count : 0) +
              (directOrderValidations.status === "fulfilled" ? directOrderValidations.value : 0),
            overdue: directOrdersUnbooked.status === "fulfilled" ? directOrdersUnbooked.value.overdue : false,
          },
          marketing: marketing.status === "fulfilled" ? marketing.value : { count: 0, overdue: false },
          marketAwareness:
            marketAwareness.status === "fulfilled" ? marketAwareness.value : { count: 0, overdue: false },
          calendarDisputes: calendarDisputes.status === "fulfilled" ? calendarDisputes.value : { count: 0 },
          deductionDisputes: deductionDisputes.status === "fulfilled" ? deductionDisputes.value : { count: 0 },
        },
      };
    });
    // Every open tab polls this every 30 s; its time goes into the per-minute process_health line.
    // A read this request actually ran keeps the name it always had, so the line still measures the
    // reads; a remembered answer and a request that joined another tab's read are counted apart.
    if (served.cache === "hit") recordTiming("badge_counts_cached", Date.now() - startedAt);
    else if (served.cache === "joined") recordTiming("badge_counts_joined", Date.now() - startedAt);
    else recordTiming("badge_counts", Date.now() - startedAt);
    return NextResponse.json(served.body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      plan: { count: 0, overdue: false },
      vacation: { count: 0, overdue: false },
      excuse: { count: 0, overdue: false },
      hub: { count: 0 },
      directOrders: { count: 0 },
      directOrdersUnbooked: { count: 0, overdue: false },
      directOrdersNeedsAction: { count: 0, overdue: false },
      marketing: { count: 0, overdue: false },
      marketAwareness: { count: 0, overdue: false },
      calendarDisputes: { count: 0 },
      deductionDisputes: { count: 0 },
    });
  }
}
