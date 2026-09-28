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
 *    and returns health/trends/payroll alongside the attention list. The six services UNDER it are
 *    called here instead.
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
import { getPayrollAwaitingPublish } from "@/lib/automated-payroll/awaiting-publish";
import {
  getExcuseAwaitingBadge,
  getPlanAwaitingBadge,
  getVacationAwaitingBadge,
} from "@/lib/approvals-hub/service";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { buildCoachingReportAnalytics } from "@/lib/coaching/analytics";
import { getCoachingReports } from "@/lib/coaching/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
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
 * probation module's OWN field, so reading it for the 30-day window and for "past its end date" is
 * reading upstream rather than inventing a second SLA here.
 */
const probationDecisions: NeedsYouAdapter = {
  id: "probation-decisions",
  load: async (access) => {
    const rows = await getProbationRows(access);
    const outstanding = rows.filter((row) => isProbationDecisionOutstanding(row) && row.days_remaining <= 30);
    if (outstanding.length === 0) return EMPTY;
    const past = outstanding.filter((row) => row.days_remaining < 0);
    return ok([
      {
        key: "probation-decisions:due",
        sourceId: "probation-decisions",
        kind: "approval",
        lane: "yours",
        label: `${outstanding.length} probation ${plural(outstanding.length, "decision is", "decisions are")} due within 30 days`,
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
];

export { isForbiddenSourceError };
