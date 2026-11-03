import type { PhoenixRole } from "@/lib/auth/permissions";
import { marketingRequestNotificationUrl } from "@/lib/marketing-requests/notification-link";
import { EXECUTION_STEP_CODE } from "@/lib/marketing-requests/request-status-label";

// ─────────────────────────────────────────────────────────────────────────────
// Finance Ageing — the pure half: who may read it, which rows belong on it, how long each has
// waited and which band that puts it in. Reads nothing, so every rule is pinned by
// tests/marketing-finance-ageing.test.ts without a database.
//
// Approved requests wait at the Finance Execution rung and no screen showed for how long. The page
// is READ-ONLY on purpose: executing stays in the Approval Inbox and the Case File, each row only
// links out to its request.
//
// A hold never appears. A hold can only be placed on an `approved` or `active` request
// (finance-hold.ts), and a request on this rung is still `pending_approval`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The waiting-time thresholds in days, shared with the daily SLA scan (`classifyMarketingWaitingSla`
 * in service.ts imports them from here). They live in this file so the band can be computed without
 * loading service.ts, and there is still only one copy.
 */
export const MARKETING_WAITING_DUE_SOON_DAYS = 3;
export const MARKETING_WAITING_OVERDUE_DAYS = 7;

export const MARKETING_FINANCE_AGEING_PATH = "/admin/marketing-requests/finance-ageing";

/**
 * Its own set, NOT `canAccessMarketingAdminPage`: that one always admits the SFE Manager, Marketing
 * Manager, Product Manager and Group Product Manager, and this page names what Finance has not yet
 * paid. The XLSX uses this same predicate, because the Finance Manager's `expenses` key is read-only
 * and the CEO's export key says nothing about this report.
 */
const financeAgeingReaderRoles = new Set<PhoenixRole>(["Super Admin", "CEO", "Finance Manager"]);

export function canViewMarketingFinanceAgeing(role: string | null | undefined): boolean {
  return Boolean(role) && financeAgeingReaderRoles.has(role as PhoenixRole);
}

export type MarketingWaitingBand = "on_time" | "due_soon" | "overdue";

/** Big is bad: the number only grows, and nothing but executing the request stops it. */
export function marketingWaitingBand(daysWaiting: number): MarketingWaitingBand {
  if (daysWaiting >= MARKETING_WAITING_OVERDUE_DAYS) return "overdue";
  if (daysWaiting >= MARKETING_WAITING_DUE_SOON_DAYS) return "due_soon";
  return "on_time";
}

export type FinanceAgeingStepInput = {
  createdAt: string | null;
  isCc: boolean;
  /** From the rung's `step_opened` event, null when none was recorded. */
  openedAt: string | null;
  requestId: string;
  status: string;
  stepCode: string;
  updatedAt: string | null;
};

export type FinanceAgeingRequestInput = {
  customerId?: string | null;
  customerName: string;
  estimatedCost: number;
  id: string;
  lineName: string;
  payDate: string | null;
  requestCode: string;
  requesterName: string;
  requestType: string;
  status: string;
};

export type MarketingFinanceAgeingRow = {
  /** No `step_opened` event exists, so the days come from the row stamps and are shown as "about". */
  approximate: boolean;
  band: MarketingWaitingBand;
  /** For the Customer 360 link on the page. Null when the request names none. */
  customerId: string | null;
  customerName: string;
  daysWaiting: number;
  estimatedCost: number;
  /** The Case File, through the same shell-neutral link every other marketing screen opens. */
  href: string;
  lineName: string;
  payDate: string | null;
  reachedFinanceAt: string | null;
  requestCode: string;
  requesterName: string;
  requestId: string;
  requestType: string;
};

export type MarketingFinanceAgeingTotals = {
  approximateCount: number;
  count: number;
  oldestDays: number;
  /** Rows in the `overdue` band, so this always equals the rows painted that colour. */
  overdueCount: number;
  totalCost: number;
};

export type MarketingFinanceAgeing = {
  generatedAtIso: string;
  rows: MarketingFinanceAgeingRow[];
  totals: MarketingFinanceAgeingTotals;
};

/** The live gating decision at Finance Execution: a CC or a rung not yet open is not waiting on him. */
export function isFinanceAgeingStep(step: Pick<FinanceAgeingStepInput, "isCc" | "status" | "stepCode">): boolean {
  return step.status === "current" && !step.isCc && step.stepCode === EXECUTION_STEP_CODE;
}

/**
 * Filter, clock, band and sort, oldest first.
 *
 * `clock` is service.ts's own `marketingWaitingSince` + `marketingDaysWaiting`, handed in so this file
 * stays free of that module and there is no second definition of "waiting since". The ties break on
 * the instant, then the code, so two renders can never order the same rows differently.
 *
 * `created_at` is NOT NULL on the rung, so the clock always has a stamp in practice; an unparseable
 * one keeps its row with 0 days and the "about" mark rather than dropping money out of the total.
 */
export function buildFinanceAgeingRows(input: {
  clock: {
    daysWaiting: (waitingSince: string | null, now: string) => number | null;
    waitingSince: (step: { createdAt?: string | null; openedAt?: string | null; updatedAt?: string | null }) => string | null;
  };
  now: string;
  requestsById: ReadonlyMap<string, FinanceAgeingRequestInput>;
  steps: readonly FinanceAgeingStepInput[];
}): MarketingFinanceAgeingRow[] {
  const rows: MarketingFinanceAgeingRow[] = [];
  for (const step of input.steps) {
    if (!isFinanceAgeingStep(step)) continue;
    const request = input.requestsById.get(step.requestId);
    if (!request || request.status !== "pending_approval") continue;
    const reachedFinanceAt = input.clock.waitingSince(step);
    const days = input.clock.daysWaiting(reachedFinanceAt, input.now);
    const daysWaiting = days ?? 0;
    rows.push({
      approximate: !step.openedAt || days === null,
      band: marketingWaitingBand(daysWaiting),
      customerId: request.customerId ?? null,
      customerName: request.customerName,
      daysWaiting,
      estimatedCost: request.estimatedCost,
      href: marketingRequestNotificationUrl(request.id),
      lineName: request.lineName,
      payDate: request.payDate,
      reachedFinanceAt,
      requestCode: request.requestCode,
      requesterName: request.requesterName,
      requestId: request.id,
      requestType: request.requestType,
    });
  }
  return rows.sort(
    (left, right) =>
      right.daysWaiting - left.daysWaiting ||
      (left.reachedFinanceAt ?? "").localeCompare(right.reachedFinanceAt ?? "") ||
      left.requestCode.localeCompare(right.requestCode),
  );
}

export function summarizeFinanceAgeing(rows: readonly MarketingFinanceAgeingRow[]): MarketingFinanceAgeingTotals {
  return {
    approximateCount: rows.filter((row) => row.approximate).length,
    count: rows.length,
    oldestDays: rows.reduce((oldest, row) => Math.max(oldest, row.daysWaiting), 0),
    overdueCount: rows.filter((row) => row.band === "overdue").length,
    totalCost: rows.reduce((sum, row) => sum + row.estimatedCost, 0),
  };
}

/** "12d", or "about 12d" when the rung has no recorded opening. */
export function financeAgeingDaysLabel(row: Pick<MarketingFinanceAgeingRow, "approximate" | "daysWaiting">): string {
  return `${row.approximate ? "about " : ""}${row.daysWaiting}d`;
}
