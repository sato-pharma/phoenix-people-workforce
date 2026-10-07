/**
 * One adapter per source. Each owns its own permission call, its own failure wording, and nothing
 * else — the fan-out and the 8-second timeout live in `service.ts`, the classification in
 * `classify.ts`.
 *
 * 🔴 WHAT IS NOT CALLED HERE, AND WHY. Three aggregators already half-answer this question and none
 * is a superset, so the temptation is to call whichever is nearest. All three are wrong to build on:
 *
 *  - `getCeoAdminSignals` (`src/lib/ceo/command-center.ts`) is not exported, is welded to
 *    `getPlatformMetrics` through a `Promise.all` — so a metrics rejection rejects the whole thing —
 *    and returns health/trends/payroll alongside the attention list. The services UNDER it are
 *    called here instead. 🔴 THE TRAFFIC NOW RUNS THE OTHER WAY for the three signals both sides
 *    held: `contract-renewals`, `probation-decisions` and `coaching-red-zone` are produced HERE
 *    and read there through `adaptersFor` + `loadNeedsYouSources`. They had drifted while there
 *    were two copies — that file's probation rule filtered to people still employed and this one's
 *    did not, so the same question had two answers. Never re-implement one of those three over
 *    there, and never "simplify" the CEO's three-adapter call into `getNeedsYouBoard`: that runs
 *    EVERY source to use three of them, on the owner's heaviest landing page.
 *  - `GET /api/approvals/badge-counts` is an HTTP hop from a server component back into its own app:
 *    it needs the session cookie, doubles the latency, and inherits the route's deliberate
 *    `{count: 0}` fallback — which is right for a badge and is the ONE shape this board must never
 *    have. The nine functions it calls are called here instead.
 *  - `getOverviewDashboard` (`src/lib/overview/service.ts`) is dead, has zero consumers, and its name
 *    will convince you it is the aggregator. It is not.
 *
 * 🔴 AND WHAT THE COACHING ADAPTER MUST NOT DO. `redZoneRepCount` counts PEOPLE. `zoneCounts` is a
 * distribution over REPORTS, and adding its two red buckets read 35 on production against an honest
 * 7 (`command-center.ts` records that misreading in its own comment). The same mistake is one line
 * away here, so it is named here too.
 */
import { getSalaryFlags } from "@/lib/admin/service";
import {
  getAwaitingMyActionItemsWithHealth,
  isForbiddenSourceError,
} from "@/lib/action-center/service";
import {
  findOrphanedRequests,
  orphanedRequestModuleLabels,
  orphanedRequestModuleScreens,
  summarizeOrphans,
} from "@/lib/approvals/orphaned-requests";
import { getPayrollAwaitingPublish } from "@/lib/automated-payroll/awaiting-publish";
import { getUncollectedLeaverDeductions } from "@/lib/deductions/uncollected-leaver-deductions";
import {
  getExcuseAwaitingBadge,
  getPlanAwaitingBadge,
  getVacationAwaitingBadge,
} from "@/lib/approvals-hub/service";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { buildCoachingReportAnalytics } from "@/lib/coaching/analytics";
import { getCoachingReports } from "@/lib/coaching/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { ApiError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPhoenixCrmDecisionCounts, phoenixCrmReadsDecisions } from "@/lib/phoenix-crm/server/needs-you";
import { listPendingPrivateCalendarDataDisputes } from "@/lib/private-calendar/disputes";
import { VALIDATION_REVIEWS_PATH } from "@/lib/phoenix-crm/server/validation-reviews";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { countDirectOrderPendingValidations } from "@/lib/direct-orders/pharmacy-validation";
import { countDirectOrderAwaitingFast, getDirectOrderUnbookedBadge } from "@/lib/direct-orders/service";
import { getMarketAwarenessDecisionBadge } from "@/lib/market-awareness/service";
import { getMarketingApproverBadge } from "@/lib/marketing-requests/service";
import { getProbationRows, isProbationDecisionOutstanding } from "@/lib/probation/service";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { listUnpublishedClosings } from "@/lib/sales/monthly-closing-publication";
import { ACTION_HUB_MODULE_LABELS, type ActionHubItem } from "@/components/action-center/types";

import {
  needsYouDestinations,
  type NeedsYouItem,
  type NeedsYouSourceId,
  type NeedsYouSourceState,
} from "./types";

export type NeedsYouAdapter = {
  id: NeedsYouSourceId;
  /**
   * May RESOLVE to a state, or REJECT. `service.ts` turns a `Forbidden:` rejection into
   * `not-applicable` and every other rejection into `unavailable` — so an adapter never has to
   * remember to catch, and a new adapter that forgets fails in the safe direction.
   */
  load: (access: AccessContext, now: Date) => Promise<NeedsYouSourceState>;
};

const EMPTY: NeedsYouSourceState = { status: "ok", items: [] };

function ok(items: readonly NeedsYouItem[]): NeedsYouSourceState {
  return { status: "ok", items };
}

/** Whole days between two instants, floored. Never negative — a future stamp reads as 0 days old. */
function ageDaysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/** Whole days from now until a date-only day, Cairo-agnostic (a day is a day in either zone). */
function daysUntil(dateOnly: string | null | undefined, now: Date): number | null {
  if (!dateOnly) return null;
  const then = new Date(`${String(dateOnly).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((then - now.getTime()) / 86_400_000);
}

/**
 * The shape every badge source collapses to: a count, an SLA verdict that came from upstream, and
 * nothing else. Returns NO item at zero — an empty lane is what a true zero looks like.
 */
function countItem(input: {
  id: NeedsYouSourceId;
  key: string;
  count: number;
  label: (count: number) => string;
  overdue: boolean;
  lane: NeedsYouItem["lane"];
  kind: NeedsYouItem["kind"];
  note?: string | null;
  href?: `/${string}`;
}): NeedsYouSourceState {
  if (input.count <= 0) return EMPTY;
  return ok([
    {
      key: input.key,
      sourceId: input.id,
      kind: input.kind,
      lane: input.lane,
      label: input.label(input.count),
      count: input.count,
      people: [],
      href: input.href ?? needsYouDestinations[input.id].href,
      externalUrl: null,
      oldestAt: null,
      ageDays: null,
      overdue: input.overdue,
      note: input.note ?? null,
    },
  ]);
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

// ── The residual approvals inbox ────────────────────────────────────────────────────────────────

/**
 * 🔴 ANY DEAD SUB-SOURCE MAKES THE WHOLE SOURCE AMBER, and the items that DID arrive are dropped.
 *
 * That is the deliberate trade, not an oversight. `getAwaitingMyActionItemsWithHealth` fans out over
 * seven queues behind one return value, and `NeedsYouSourceState` has no branch that carries items
 * AND a failure — because structural guarantee 1 is that a failed source can write no number
 * anywhere. Reporting `ok` with a short list would be exactly the swallowed failure this module
 * exists to end: a dead resignations read would render as "no resignations".
 *
 * Nothing is lost that matters, because the amber row NAMES each queue that did not answer, and it
 * renders in band ONE — above the work. A reader who sees "Resignations · <reason>" opens the Action
 * Center, which is the same click the dropped rows would have offered.
 */
const actionInbox: NeedsYouAdapter = {
  id: "action-inbox",
  load: async (access) => {
    // The SAME gate `/api/approvals/badge-counts` puts in front of this read. See `hubBadge` below
    // for why the adapter asserts it rather than leaning on the page.
    await assertPermission(access, "leave", "read");
    const { items, unavailable } = await getAwaitingMyActionItemsWithHealth(access, "admin");
    if (unavailable.length > 0) {
      return {
        status: "unavailable",
        because: unavailable.map((failure) => `${failure.source}: ${failure.because}`).join("; "),
      };
    }
    const byModule = new Map<ActionHubItem["module"], ActionHubItem[]>();
    for (const item of items) {
      const bucket = byModule.get(item.module);
      if (bucket) bucket.push(item);
      else byModule.set(item.module, [item]);
    }
    const out: NeedsYouItem[] = [];
    for (const [module, bucket] of byModule) {
      const moduleLabel = ACTION_HUB_MODULE_LABELS[module] ?? module;
      const oldestAt = bucket
        .map((item) => item.submittedAt)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))[0] ?? null;
      out.push({
        key: `action-inbox:${module}`,
        sourceId: "action-inbox",
        kind: "approval",
        lane: "yours",
        label: `${moduleLabel} ${plural(bucket.length, "request", "requests")} awaiting your decision`,
        count: bucket.length,
        // Names, never HR ids — the item type has no field for an id, so this is the only shape.
        people: [...new Set(bucket.map((item) => item.employeeName).filter(Boolean))],
        href: needsYouDestinations["action-inbox"].href,
        externalUrl: null,
        oldestAt,
        // UPSTREAM's verdict on both counts: `slaIsOverdue` and `slaAgeDays` are the inbox's own SLA
        // fields. Nothing is re-derived here, so the two screens cannot disagree.
        ageDays: bucket.reduce<number | null>(
          (worst, item) => (typeof item.slaAgeDays === "number" ? Math.max(worst ?? 0, item.slaAgeDays) : worst),
          null,
        ),
        overdue: bucket.some((item) => item.slaIsOverdue === true),
        note: null,
      });
    }
    return ok(out);
  },
};

// ── The three Approvals Hub badges ──────────────────────────────────────────────────────────────

/**
 * All three already carry `available: boolean`, and that flag is the whole reason they can be used
 * here: each one CATCHES its own failure and returns `{count: 0, overdue: false, available: false}`.
 * Reading only `count` would read a dead queue as an empty one — the badge shape, correct for a
 * badge, fatal here. So `available === false` becomes `unavailable`, in words.
 *
 * 🔴 AND THE PERMISSION IS ASSERTED HERE, not left to the page. None of these three asserts its own
 * resource — `/api/approvals/badge-counts` wraps each in the `assertPermission` call the queue
 * needs, and reading them bare would inherit the scoping without the gate. Leaning on
 * `/admin/needs-you` being Super-Admin-only would be true today and is the wrong shape: the module
 * would then be correct only because of a caller, and `not-applicable` — the third state this whole
 * design turns on — could never be reached for these three at all.
 */
function hubBadge(
  id: NeedsYouSourceId,
  resource: "weekly_plans" | "leave",
  read: (access: AccessContext) => Promise<{ count: number; overdue: boolean; available: boolean }>,
  label: (count: number) => string,
): NeedsYouAdapter {
  return {
    id,
    load: async (access) => {
      // Throws `Forbidden:` for a viewer with no rung, which `service.ts` classifies as a TRUE zero.
      await assertPermission(access, resource, "read");
      const badge = await read(access);
      if (!badge.available) {
        return { status: "unavailable", because: "the queue did not answer (it reported itself unavailable)" };
      }
      return countItem({ id, key: `${id}:awaiting`, count: badge.count, label, overdue: badge.overdue, lane: "yours", kind: "approval" });
    },
  };
}

const planApprovals = hubBadge(
  "plan-approvals",
  "weekly_plans",
  getPlanAwaitingBadge,
  (count) => `${count} weekly or monthly ${plural(count, "plan", "plans")} awaiting your approval`,
);

const leaveApprovals = hubBadge(
  "leave-approvals",
  "leave",
  getVacationAwaitingBadge,
  (count) => `${count} leave ${plural(count, "request", "requests")} awaiting your approval`,
);

const excuseApprovals = hubBadge(
  "excuse-approvals",
  "leave",
  getExcuseAwaitingBadge,
  (count) => `${count} excuse ${plural(count, "request", "requests")} awaiting your approval`,
);

// ── Direct orders — THREE sources, not one ──────────────────────────────────────────────────────

/**
 * Split deliberately, where `/api/approvals/badge-counts` sums them into one `directOrdersNeedsAction`.
 * A badge wants one number; this board wants to know WHICH of the three could not be read, because a
 * merged source means one dead read hides two healthy queues behind a single amber row.
 */
const directOrderApprovals: NeedsYouAdapter = {
  id: "direct-order-approvals",
  load: async (access) =>
    countItem({
      id: "direct-order-approvals",
      key: "direct-order-approvals:awaiting",
      count: await countDirectOrderAwaitingFast(access),
      label: (count) => `${count} direct ${plural(count, "order", "orders")} awaiting your approval rung`,
      overdue: false,
      lane: "yours",
      kind: "approval",
    }),
};

/**
 * Approved orders with no sales month. This is FINANCE's step, not an approval — the one person who
 * owns it holds no approval rung at all — but the badge already returns 0 to anyone who cannot book a
 * month, so a non-zero reading here means the viewer CAN clear it. It stays in `yours` for that
 * reason; over-reporting a row he can act on is the safe direction.
 *
 * 🔴 The month is Finance's to book (the direct-order month golden rule: an order counts in the month
 * FINANCE books it). This board never books one — it links to the screen that does.
 */
const directOrderUnbooked: NeedsYouAdapter = {
  id: "direct-order-unbooked",
  load: async (access) => {
    const badge = await getDirectOrderUnbookedBadge(access);
    return countItem({
      id: "direct-order-unbooked",
      key: "direct-order-unbooked:awaiting",
      count: badge.count,
      label: (count) => `${count} approved direct ${plural(count, "order", "orders")} waiting on a sales month`,
      overdue: badge.overdue,
      lane: "yours",
      kind: "approval",
      note: "Finance books the month; nothing here changes one.",
    });
  },
};

const directOrderValidations: NeedsYouAdapter = {
  id: "direct-order-validations",
  load: async (access) =>
    countItem({
      id: "direct-order-validations",
      key: "direct-order-validations:pending",
      count: await countDirectOrderPendingValidations(access),
      label: (count) => `${count} pharmacy ${plural(count, "claim", "claims")} awaiting confirmation`,
      overdue: false,
      lane: "yours",
      kind: "approval",
    }),
};

// ── Marketing and awareness ─────────────────────────────────────────────────────────────────────

/**
 * `getMarketingApproverBadge`, never `getApproverPendingRequests`: it already drops the
 * `assigned_hr_id` filter for a `canViewMarketingOversightQueue` viewer (the Super Admin), so the
 * count is the whole queue rather than only the steps assigned to him by name — and it THROWS rather
 * than returning 0, which is the behaviour this board needs.
 */
const marketingApprovals: NeedsYouAdapter = {
  id: "marketing-approvals",
  load: async (access) => {
    const badge = await getMarketingApproverBadge(access);
    return countItem({
      id: "marketing-approvals",
      key: "marketing-approvals:current",
      count: badge.count,
      label: (count) => `${count} marketing ${plural(count, "request", "requests")} at your step`,
      overdue: badge.overdue,
      lane: "yours",
      kind: "approval",
    });
  },
};

const marketAwarenessApprovals: NeedsYouAdapter = {
  id: "market-awareness-approvals",
  load: async (access) => {
    const badge = await getMarketAwarenessDecisionBadge(access);
    return countItem({
      id: "market-awareness-approvals",
      key: "market-awareness-approvals:open",
      count: badge.count,
      label: (count) => `${count} awareness ${plural(count, "activity", "activities")} awaiting your decision`,
      overdue: badge.overdue,
      lane: "yours",
      kind: "approval",
    });
  },
};

// ── Monthly closings ────────────────────────────────────────────────────────────────────────────

/**
 * `listUnpublishedClosings` THROWS by design — an empty array from it would mean "every month is
 * published", the exact under-report. It is caught by `service.ts` into an amber row, and the
 * `catch { return []; }` its own header warns against is not restored here either.
 *
 * `count: null` because a month is not a quantity. The line NAMES come back as the closing module
 * spelled them (`selectUnpublishedClosings` reports the display casing, not the lookup key), so this
 * prints "Anti Infective", never "anti infective".
 *
 * Nothing here can print Head Office: `listMonthlyClosingLines` runs every caller through
 * `selectClosingLines`, which drops it. And the running month cannot appear — the period gate is
 * resolved in Cairo upstream, which is also what keeps a closing off this board during the month it
 * covers.
 */
const monthlyClosings: NeedsYouAdapter = {
  id: "monthly-closings",
  load: async (_access, now) => {
    const periods = await listUnpublishedClosings(now);
    return ok(
      periods.map((period) => ({
        key: `monthly-closings:${period.period}`,
        sourceId: "monthly-closings" as const,
        kind: "publish" as const,
        lane: "yours" as const,
        label: `${period.period} is not published for ${period.unpublishedLines.join(", ")}`,
        count: null,
        people: [],
        href: needsYouDestinations["monthly-closings"].href,
        externalUrl: null,
        oldestAt: period.opensOn,
        ageDays: period.opensOn ? -(daysUntil(period.opensOn, now) ?? 0) : null,
        // No SLA upstream, so no verdict invented here.
        overdue: false,
        note:
          period.publishedLines.length > 0
            ? `Already published for ${period.publishedLines.join(", ")}.`
            : null,
      })),
    );
  },
};

// ── Payroll ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `getPayrollAwaitingPublish` throws on a missing table by design, for the same reason as the
 * closings read; `service.ts` catches it into amber.
 *
 * 🔴 NO MONEY ON THIS BOARD. `outstandingHolds` carries a per-person `outstanding` AMOUNT, and this
 * adapter reports only HOW MANY people and WHICH months. Two rules meet here: no payslip figure
 * belongs on an overview surface for any role, and a money figure is never something the owner is
 * asked to act on away from the screen that owns it. The Automated Payroll screen shows the amounts;
 * this row says there is something to look at and links there.
 */
const payrollPublish: NeedsYouAdapter = {
  id: "payroll-publish",
  load: async (access, now) => {
    const payroll = await getPayrollAwaitingPublish(access);
    const items: NeedsYouItem[] = [];

    for (const run of payroll.ready) {
      items.push({
        key: `payroll-publish:ready:${run.runId}`,
        sourceId: "payroll-publish",
        kind: "publish",
        lane: "yours",
        label: `${run.monthLabel} payroll is confirmed and not published`,
        count: null,
        people: [],
        href: needsYouDestinations["payroll-publish"].href,
        externalUrl: null,
        oldestAt: run.confirmedAt,
        ageDays: ageDaysSince(run.confirmedAt, now),
        overdue: false,
        note:
          run.heldCount === null
            ? "How many rows this run is holding could not be counted."
            : run.heldCount > 0
              ? `${run.heldCount} ${plural(run.heldCount, "row is", "rows are")} on hold and will not be published.`
              : null,
      });
    }

    for (const run of payroll.inProgress) {
      items.push({
        key: `payroll-publish:in-progress:${run.runId}`,
        sourceId: "payroll-publish",
        kind: "publish",
        lane: "someone-else",
        label: `${run.monthLabel} payroll is still being worked on`,
        count: null,
        people: [],
        href: needsYouDestinations["payroll-publish"].href,
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: "Reported so an abandoned month is visible, never as work waiting on you.",
      });
    }

    if (payroll.outstandingHolds.length > 0) {
      const months = [...new Set(payroll.outstandingHolds.map((hold) => hold.monthLabel))];
      items.push({
        key: "payroll-publish:outstanding-holds",
        sourceId: "payroll-publish",
        kind: "flag",
        lane: "worth-knowing",
        label: `${payroll.outstandingHolds.length} ${plural(payroll.outstandingHolds.length, "person has", "people have")} money withheld at a past publish`,
        count: payroll.outstandingHolds.length,
        people: [...new Set(payroll.outstandingHolds.map((hold) => hold.name).filter(Boolean))],
        href: "/admin/automated-payroll/finance",
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: `Across ${months.join(", ")}. Figures are on the payroll screen, never here.`,
      });
    }

    if (payroll.holdsIncomplete) {
      items.push({
        key: "payroll-publish:holds-incomplete",
        sourceId: "payroll-publish",
        kind: "flag",
        lane: "worth-knowing",
        label: "At least one month recorded a hold count with no names",
        count: null,
        people: [],
        href: "/admin/automated-payroll/finance",
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: "Pre-2026-09-10 runs filed holds that way, so the list above cannot be complete.",
      });
    }

    return ok(items);
  },
};

// ── The six services under the CEO's attention list ─────────────────────────────────────────────

const resignations: NeedsYouAdapter = {
  id: "resignations",
  load: async (access) => {
    const data = await getResignationsDashboardData(access);
    const pending = data.records.filter((record) => record.status === "submitted" || record.status === "under_review");
    if (pending.length === 0) return EMPTY;
    return ok([
      {
        key: "resignations:pending",
        sourceId: "resignations",
        kind: "flag",
        // WORTH KNOWING, not `yours`: the resignations in the workflow are already offered as a
        // decision by `action-inbox` above. This row is the standing figure, so a reader who sees
        // the amber action-inbox row still learns the queue is not empty.
        lane: "worth-knowing",
        label: `${pending.length} ${plural(pending.length, "resignation is", "resignations are")} in the workflow`,
        count: pending.length,
        people: [...new Set(pending.map((record) => record.employeeName).filter(Boolean))],
        href: needsYouDestinations.resignations.href,
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: null,
      },
    ]);
  },
};

const contractRenewals: NeedsYouAdapter = {
  id: "contract-renewals",
  load: async (access, now) => {
    const data = await getContractRenewalDashboardData(access);
    const items: NeedsYouItem[] = [];

    if (data.summary.hrReview > 0) {
      items.push({
        key: "contract-renewals:hr-review",
        sourceId: "contract-renewals",
        kind: "approval",
        lane: "yours",
        label: `${data.summary.hrReview} contract ${plural(data.summary.hrReview, "renewal is", "renewals are")} at HR review`,
        count: data.summary.hrReview,
        people: [
          ...new Set(
            data.rows
              .filter((row) => row.workflow?.status === "hr_review")
              .map((row) => row.full_name)
              .filter(Boolean),
          ),
        ],
        href: needsYouDestinations["contract-renewals"].href,
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: null,
      });
    }

    if (data.summary.managerReview > 0) {
      items.push({
        key: "contract-renewals:manager-review",
        sourceId: "contract-renewals",
        kind: "approval",
        lane: "someone-else",
        label: `${data.summary.managerReview} contract ${plural(data.summary.managerReview, "renewal is", "renewals are")} with a manager`,
        count: data.summary.managerReview,
        people: [
          ...new Set(
            data.rows
              .filter((row) => row.workflow?.status === "manager_review")
              .map((row) => row.full_name)
              .filter(Boolean),
          ),
        ],
        href: needsYouDestinations["contract-renewals"].href,
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: null,
      });
    }

    // Same 30-day window the CEO board uses, read from the same column.
    const expiring = data.rows.filter((row) => {
      const days = daysUntil(row.contract_renewal_date, now);
      return days !== null && days >= 0 && days <= 30;
    });
    if (expiring.length > 0) {
      items.push({
        key: "contract-renewals:expiring",
        sourceId: "contract-renewals",
        kind: "expiry",
        lane: "worth-knowing",
        label: `${expiring.length} ${plural(expiring.length, "contract expires", "contracts expire")} within 30 days`,
        count: expiring.length,
        people: [...new Set(expiring.map((row) => row.full_name).filter(Boolean))],
        href: needsYouDestinations["contract-renewals"].href,
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: null,
      });
    }

    return ok(items);
  },
};

/**
 * A probation decision is outstanding when the workflow has not reached a final state
 * (`isProbationDecisionOutstanding`, reused rather than re-expressed). `days_remaining` is the
 * probation module's OWN field, so reading it for the window and for "past its end date" is reading
 * upstream rather than inventing a second SLA here.
 *
 * 🔴 THE EMPLOYMENT-STATUS FILTER IS APPLIED HERE AND NOT INHERITED, AND IT COST A PRODUCTION
 * DEFECT TO LEARN. `getProbationRows` deliberately applies no status rule: it is built from the
 * employee directory's hire+90 window, the tracker's own status filter defaults to "all", and
 * /probation is MEANT to keep showing a probationer who resigned mid-window so HR can close the
 * record. A "decisions due" figure is a different question — a person who has left needs no
 * decision — and in production a resigned Medical Representative (PD-0003, 10 days remaining) was
 * counted as outstanding until this filter existed. The count is therefore a SUBSET of the page it
 * links to, never a disjoint set: an attention row is a LINK, so its number has to describe the
 * page it opens. An older version of this count scanned `probation_evaluations` directly for
 * people past their end date; `getProbationRows` ends with `days_remaining > 0`, so that figure
 * counted exactly the people the destination table cannot contain — the CEO clicked 22 and landed
 * on a list holding none of them.
 *
 * There is deliberately no "overdue" COUNT: no surface in the product lists a probationer past the
 * 90-day window, so such a number would be another dead link. The `note` below says how many are
 * past the date without offering it as its own row; a real overdue count needs an overdue view on
 * /probation first.
 *
 * 🔴 THE TWO FILTERS ARE NOT DECORATION, and this adapter shipped without them. A
 * probationer whose employment has already ENDED still carries an unresolved workflow row, so
 * without `isActiveLifecycleStatus` this counted leavers as decisions the owner still owes — and
 * the number it produced was therefore higher than the CEO command centre's, which has always
 * filtered them. The window is `lifecycleRiskWindows.probationCriticalDays`, not a literal 30:
 * that constant is the one place the product defines "due soon", and a second copy of the number
 * here is how the two screens would disagree the day it moves.
 */
const probationDecisions: NeedsYouAdapter = {
  id: "probation-decisions",
  load: async (access) => {
    const rows = await getProbationRows(access);
    const outstanding = rows.filter(
      (row) =>
        isActiveLifecycleStatus(row.employment_status) &&
        isProbationDecisionOutstanding(row) &&
        row.days_remaining <= lifecycleRiskWindows.probationCriticalDays,
    );
    if (outstanding.length === 0) return EMPTY;
    const past = outstanding.filter((row) => row.days_remaining < 0);
    return ok([
      {
        key: "probation-decisions:due",
        sourceId: "probation-decisions",
        kind: "approval",
        lane: "yours",
        label: `${outstanding.length} probation ${plural(outstanding.length, "decision is", "decisions are")} due within ${lifecycleRiskWindows.probationCriticalDays} days`,
        count: outstanding.length,
        people: [...new Set(outstanding.map((row) => row.full_name).filter(Boolean))],
        href: needsYouDestinations["probation-decisions"].href,
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: past.length > 0,
        note: past.length > 0 ? `${past.length} of them are already past the probation end date.` : null,
      },
    ]);
  },
};

/**
 * 🔴 `redZoneRepCount` — PEOPLE. Not the two red `zoneCounts` buckets, which are a distribution over
 * REPORTS and read 35 on production against an honest 7.
 */
const coachingRedZone: NeedsYouAdapter = {
  id: "coaching-red-zone",
  load: async (access) => {
    const analytics = buildCoachingReportAnalytics(await getCoachingReports({}, access));
    return countItem({
      id: "coaching-red-zone",
      key: "coaching-red-zone:reps",
      count: analytics.redZoneRepCount,
      label: (count) => `${count} ${plural(count, "rep is", "reps are")} in the coaching red zone`,
      overdue: false,
      // State, not a decision. Nothing on this row is blocked on a click of his.
      lane: "worth-knowing",
      kind: "flag",
    });
  },
};

/**
 * The system FLAGS; it never auto-rejects. So this is a queue to LOOK at rather than a decision
 * waiting on him, which is why it sits in `worth-knowing` and not in the headline count.
 */
const salaryFlags: NeedsYouAdapter = {
  id: "salary-flags",
  load: async () =>
    countItem({
      id: "salary-flags",
      key: "salary-flags:unresolved",
      count: (await getSalaryFlags()).unresolvedCount,
      label: (count) => `${count} salary ${plural(count, "flag is", "flags are")} unresolved`,
      overdue: false,
      lane: "worth-knowing",
      kind: "flag",
    }),
};

// ── Orphaned requests ─────────────────────────────────────────────────────────────────────────────

/**
 * A request in any chain (marketing, direct orders, vacation) that can no longer move because the one
 * person who must act next has left the company — a `returned` request whose requester has resigned
 * and can never resubmit it, or an approval rung named to a person who has left. `findOrphanedRequests`
 * owns the rule (and the three-chain read); this adapter only groups and labels.
 *
 * 🔴 WORTH-KNOWING, never `yours`. It is a cleanup to look at, not a rung decision only he can take,
 * and the fix — reassign the step, or close the request — is taken on the module's own screen, which
 * each item links to. The board links; it never acts.
 *
 * 🔴 NO MONEY ON THIS ROW. A direct order carries a value, and that value is never stated here: the
 * row names how many are stranded and on whom, and the figure lives on the Direct Orders screen. Same
 * rule the payroll adapter keeps.
 *
 * 🔴 IT THROWS rather than returning empty when a chain cannot be read — `service.ts` turns that into
 * the amber "could not be read" row. "Nothing is stranded" and "a chain did not answer" are different
 * facts, and only the first may read as calm.
 */
const orphanedRequests: NeedsYouAdapter = {
  id: "orphaned-requests",
  load: async (_access, now) => {
    const groups = summarizeOrphans(await findOrphanedRequests());
    const items: NeedsYouItem[] = groups.map((group) => {
      const noun = group.count === 1
        ? orphanedRequestModuleLabels[group.module]
        : `${orphanedRequestModuleLabels[group.module]}s`;
      const them = group.count === 1 ? "it" : "them";
      const screen = orphanedRequestModuleScreens[group.module];
      const label = group.actorRole === "requester"
        ? `${group.count} ${noun} ${plural(group.count, "is", "are")} stuck — the rep who raised ${them} has left`
        : `${group.count} ${noun} ${plural(group.count, "is", "are")} stuck — the approver on ${them} has left`;
      const note = group.actorRole === "requester"
        ? `Handed back to edit, but the rep has resigned and can never resubmit ${them} — reassign or close ${them} on the ${screen.screen} screen.`
        : `The approver named on the current rung has left, so ${them} cannot advance — reassign the rung on the ${screen.screen} screen.`;
      return {
        key: `orphaned-requests:${group.module}:${group.actorRole}`,
        sourceId: "orphaned-requests" as const,
        kind: "flag" as const,
        lane: "worth-knowing" as const,
        label,
        count: group.count,
        people: group.people,
        href: screen.href,
        externalUrl: null,
        oldestAt: group.oldestAt,
        ageDays: ageDaysSince(group.oldestAt, now),
        overdue: false,
        note,
      };
    });
    return ok(items);
  },
};

// ── Phoenix CRM ─────────────────────────────────────────────────────────────────────────────────

/**
 * Phoenix CRM's own decisions (added 2026-10-03): a list request and an off-plan visit at THIS
 * viewer's step, how much of the carried-over lists is still waiting to be validated, and — since
 * 2026-10-05 — the places the Google Maps check could not settle, which only the Super Admin decides.
 *
 * 🔴 IT COUNTS NOTHING ITSELF. Every figure comes from `loadPhoenixCrmDecisionCounts`, which reads the
 * module's own producer — the same one the Phoenix CRM page's "waiting for you" badge reads — so the
 * board and the module cannot disagree about whose turn it is. The reasons the two decision counts may
 * be TEST entries, why the validation figure is always real, and why a medical rep is
 * `not-applicable`, are all in that file's header.
 *
 * 🔴 AND IT NEVER ACTS, AND NEVER CARRIES A MEASUREMENT. This board links; the Phoenix CRM Team tab
 * owns every one of these decisions. Nothing here reads a distance, an accuracy, a location flag or
 * any integrity signal — Phoenix CRM's golden rule #1 keeps those to the Super Admin and the SFE
 * Manager inside the module, and a central board is not a back door to them.
 */
const phoenixCrmDecisions: NeedsYouAdapter = {
  id: "phoenix-crm-decisions",
  load: async (access, now) => {
    // The module's own gate, asserted HERE and not left to the page — the same shape `hubBadge` uses
    // and for the same reason: a `Forbidden:` rejection is classified as a TRUE zero upstream.
    await assertPermission(access, "phoenix_crm", "read");
    let viewer: PhoenixCrmViewer;
    try {
      viewer = await resolvePhoenixCrmViewer(access);
    } catch (error) {
      // 🔴 `resolvePhoenixCrmViewer` refuses a login with no HR record through `forbiddenError`, whose
      // message does NOT begin "Forbidden:" — so `service.ts` would read it as amber and the board
      // would carry a permanent "could not be read" row for an account that simply holds no seat.
      // A 403 from the module is a viewer with no rung, which is the third state.
      if (error instanceof ApiError && error.status === 403) {
        return { status: "not-applicable", because: error.message };
      }
      throw error;
    }
    if (!phoenixCrmReadsDecisions(viewer)) {
      return {
        status: "not-applicable",
        because: "Phoenix CRM decisions belong to a territory's managers, the SFE Manager and the Super Admin",
      };
    }
    const counts = await loadPhoenixCrmDecisionCounts(viewer);
    // Said on every row the test world produced, because a test entry is a real row of his own making
    // and a reader has to be able to tell the two apart at a glance.
    const world = counts.isTest ? "These are test entries — the Super Admin's own entries in Phoenix CRM are test entries." : null;
    const items: NeedsYouItem[] = [];

    if (counts.listRequests > 0) {
      items.push({
        key: "phoenix-crm-decisions:list-requests",
        sourceId: "phoenix-crm-decisions",
        kind: "approval",
        lane: "yours",
        label: `${counts.listRequests} Phoenix CRM list ${plural(counts.listRequests, "request is", "requests are")} at your step`,
        count: counts.listRequests,
        people: [],
        href: needsYouDestinations["phoenix-crm-decisions"].href,
        externalUrl: null,
        // No SLA upstream, so no verdict and no age invented here.
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: world ?? "A grade, a drop, an add or a bring-back — including the add an out-of-list visit files at the door.",
      });
    }

    if (counts.offPlanVisits > 0) {
      items.push({
        key: "phoenix-crm-decisions:off-plan-visits",
        sourceId: "phoenix-crm-decisions",
        kind: "approval",
        lane: "yours",
        label: `${counts.offPlanVisits} off-plan ${plural(counts.offPlanVisits, "visit is", "visits are")} waiting for your approval`,
        count: counts.offPlanVisits,
        people: [],
        href: needsYouDestinations["phoenix-crm-decisions"].href,
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        // The cost of the delay, stated plainly. It is the module's own rule, not an SLA.
        note: world ?? "An off-plan visit counts in nothing until it is decided, so the rep's figures wait on this.",
      });
    }

    // Added 2026-10-05, the day the owner put this queue on email, in-app and Telegram by name. The
    // board is the fourth way the same hold reaches him and the only one still showing it tomorrow,
    // so a notice read at midnight and left is not a notice lost.
    if (counts.placeChecks > 0) {
      items.push({
        key: "phoenix-crm-decisions:place-checks",
        sourceId: "phoenix-crm-decisions",
        kind: "approval",
        // HIS OWN LANE, and the strongest claim to it in this module: the Super Admin is the only
        // person who can decide a held place, so nobody else can clear this row for him.
        lane: "yours",
        label: `${counts.placeChecks} ${plural(counts.placeChecks, "place is", "places are")} held for your approval`,
        count: counts.placeChecks,
        people: [],
        // 🔴 ITS OWN HREF, not the source's Team tab — that screen cannot decide one of these. The
        // `orphaned-requests` source carries per-item hrefs for the same reason.
        href: VALIDATION_REVIEWS_PATH,
        externalUrl: null,
        // An age, because this one has a cost that grows: the customer stays unvalidated meanwhile.
        // Still no `overdue` verdict — the module publishes no SLA for it and this board invents none.
        oldestAt: counts.oldestPlaceCheckAt,
        ageDays: ageDaysSince(counts.oldestPlaceCheckAt, now),
        overdue: false,
        note: "The system could not confirm the place, so it is waiting on you. Until it is decided the customer stays unvalidated and a visit there scores nothing.",
      });
    }

    if (counts.awaitingValidation > 0) {
      items.push({
        key: "phoenix-crm-decisions:awaiting-validation",
        sourceId: "phoenix-crm-decisions",
        kind: "flag",
        // WORTH KNOWING, never `yours`: validating a carried-over customer is the rep's own work, and
        // a district manager may do it beside him (owner, 2026-10-02) — but nothing in it is blocked
        // on a decision only this viewer can make, which is what the `yours` lane means.
        lane: "worth-knowing",
        label: `${counts.awaitingValidation} carried-over ${plural(counts.awaitingValidation, "customer is", "customers are")} still waiting to be validated`,
        count: counts.awaitingValidation,
        people: [],
        href: needsYouDestinations["phoenix-crm-decisions"].href,
        externalUrl: null,
        oldestAt: null,
        ageDays: null,
        overdue: false,
        note: `Across ${counts.territories} ${plural(counts.territories, "territory", "territories")}. A visit to a customer nobody has validated yet is saved and scores nothing.`,
      });
    }

    return ok(items);
  },
};

// ── Uncollected leaver deductions ─────────────────────────────────────────────────────────────────

/**
 * A leaver who left with an APPROVED deduction that was never collected on-system, while their final
 * settlement is plausibly still open — the preventive window where it can still be netted in on the
 * Deductions screen.
 *
 * 🔴 THE OWNER'S SCOPE, 2026-10-07. Once a leaver is gone and paid, the money is unrecoverable —
 * "nothing to do". So the producer reads forward only (never the closed August-2026 cohort, settled
 * off-system) and within a rolling window, so this is about the NEXT one, never a growing ledger of
 * gone money. `getUncollectedLeaverDeductions` owns that rule and asserts `deductions:read`, so a
 * viewer with no rung is a TRUE zero (`not-applicable`) and a failed read THROWS → amber, never calm.
 *
 * 🔴 WORTH-KNOWING, never `yours`, and NO MONEY. The settlement is taken on /admin/deductions, which
 * every item links to; this row names HOW MANY leavers and WHO, never the EGP — the same rule the
 * payroll and orphaned-requests adapters keep. An age, because the cost grows as the final pay nears.
 */
const uncollectedLeaverDeductions: NeedsYouAdapter = {
  id: "uncollected-leaver-deductions",
  load: async (access, now) => {
    const leavers = await getUncollectedLeaverDeductions(access);
    if (leavers.length === 0) return EMPTY;
    const oldestAt = leavers
      .map((leaver) => leaver.lastWorkingDate)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))[0] ?? null;
    return ok([
      {
        key: "uncollected-leaver-deductions:open",
        sourceId: "uncollected-leaver-deductions",
        kind: "flag",
        lane: "worth-knowing",
        label: `${leavers.length} ${plural(leavers.length, "leaver has", "leavers have")} left with an approved deduction not yet collected`,
        count: leavers.length,
        people: [...new Set(leavers.map((leaver) => leaver.name).filter((name): name is string => Boolean(name)))],
        href: needsYouDestinations["uncollected-leaver-deductions"].href,
        externalUrl: null,
        oldestAt,
        ageDays: ageDaysSince(oldestAt, now),
        overdue: false,
        note: "Settle it on the Deductions screen before their final pay goes out — once a leaver is paid it cannot be recovered. Figures are on that screen, never here.",
      },
    ]);
  },
};

// ── Private Calendar ────────────────────────────────────────────────────────────────────────────

/**
 * Review requests an employee raised on one of his own calendar days (added 2026-10-07).
 *
 * The decision is SUPER ADMIN ONLY end to end — `assertDisputeDecisionActor` in
 * `private-calendar/disputes.ts` is a narrower gate than the attendance matrix, deliberately, because
 * these days feed pay. So nobody else can clear this row for him, which is the strongest claim there
 * is to the `yours` lane, and every other viewer gets the third state rather than a zero about a queue
 * they cannot see.
 *
 * 🔴 WHY IT IS ON THE BOARD AT ALL. The request already notifies him on submission — email, in-app and
 * push, plus the standing Telegram mirror — but that notice fires once, and the Disputes Inbox is a tab
 * he has to remember to open. One request sat pending for two days with nothing re-raising it. The
 * board is the only channel that still shows it tomorrow.
 *
 * It counts nothing itself: the one producer is the same function the hub's Disputes Inbox tab reads,
 * so the board and the tab can never disagree about how many are waiting.
 */
const calendarReviewRequests: NeedsYouAdapter = {
  id: "calendar-review-requests",
  load: async (access, now) => {
    if (access.role !== "Super Admin") {
      return {
        status: "not-applicable",
        because: "A calendar review request is decided by the Super Admin alone",
      };
    }
    const pending = await listPendingPrivateCalendarDataDisputes(access);
    if (pending.length === 0) return EMPTY;
    const oldestAt = pending
      .map((request) => request.createdAt)
      .sort((left, right) => String(left).localeCompare(String(right)))[0] ?? null;
    return ok([
      {
        key: "calendar-review-requests:pending",
        sourceId: "calendar-review-requests",
        kind: "approval",
        lane: "yours",
        label: `${pending.length} calendar review ${plural(pending.length, "request is", "requests are")} waiting for your decision`,
        count: pending.length,
        // Names, never HR ids — the owner's standing rule, and the request row carries the name it was
        // submitted with. An unnamed row is left out rather than printed as a code.
        people: Array.from(new Set(pending.map((request) => request.employeeName).filter((name): name is string => Boolean(name)))),
        href: needsYouDestinations["calendar-review-requests"].href,
        externalUrl: null,
        oldestAt,
        ageDays: ageDaysSince(oldestAt, now),
        // No SLA on these upstream, so no verdict is invented here.
        overdue: false,
        note: "An employee says the calendar is wrong about one day. Read the conversation on the request and reply there before accepting or declining it.",
      },
    ]);
  },
};

/**
 * THE REGISTRY. `service.ts` fans out over exactly this array, and
 * `tests/needs-you-never-under-reports.test.ts` holds its ids against `needsYouSourceIds` — so an
 * adapter added without a source id, or a source id with no adapter, fails CI. That pairing is what
 * makes "one entry per source, always" true rather than intended.
 */
export const needsYouAdapters: readonly NeedsYouAdapter[] = [
  actionInbox,
  planApprovals,
  leaveApprovals,
  excuseApprovals,
  directOrderApprovals,
  directOrderUnbooked,
  directOrderValidations,
  marketingApprovals,
  marketAwarenessApprovals,
  monthlyClosings,
  payrollPublish,
  resignations,
  contractRenewals,
  probationDecisions,
  coachingRedZone,
  salaryFlags,
  phoenixCrmDecisions,
  orphanedRequests,
  uncollectedLeaverDeductions,
  calendarReviewRequests,
];

/**
 * The adapters for a named set of sources, in registry order — the door `getCeoAdminSignals` comes
 * in through, so its three shared signals are produced HERE and not a second time over there.
 *
 * 🔴 IT THROWS on an id with no adapter rather than skipping it. A silent drop would hand the caller
 * a shorter list than it asked for, and a caller that asked for three signals and got two would
 * render two — the under-report this module exists to prevent, arriving through the one door left
 * open. `needsYouSourceIds` is a closed union, so a typo is already a compile error; this guards
 * the case the type cannot see, an id whose adapter was removed from the registry.
 */
export function adaptersFor(ids: readonly NeedsYouSourceId[]): readonly NeedsYouAdapter[] {
  return ids.map((id) => {
    const adapter = needsYouAdapters.find((entry) => entry.id === id);
    if (!adapter) throw new Error(`needs-you: no adapter is registered for source "${id}"`);
    return adapter;
  });
}


export { isForbiddenSourceError };
