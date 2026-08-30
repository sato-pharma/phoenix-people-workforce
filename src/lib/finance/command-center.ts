import { unstable_cache } from "next/cache.js";

import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { getFinanceAvailability } from "@/lib/automated-payroll/run-service";
import { FINANCE_DASHBOARD_CACHE_TAG } from "@/lib/dashboard/invalidation";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/observability/log";

/**
 * Finance Command Center — the Finance Manager's landing dashboard.
 *
 * ONE `.rpc()` call and nothing else. That constraint is the whole design, and
 * tests/finance-command-center.test.ts enforces it mechanically (exactly one `.rpc(`, zero
 * `.from(`), because the obvious alternative is what makes the CEO Command Center slow: its
 * Phase A composes domain services that fan out, transitively, into the low hundreds of round
 * trips. Every service that could have supplied a tile here carries the same problem —
 * getDirectOrderReport reads the whole table across ~5 sequential waves,
 * getMarketingRequestDraftWorkspace is an 11-query Promise.all. So the aggregation lives in
 * Postgres and comes back assembled.
 *
 * (getVacationWorkspaceData's several calls into getVacationReportData({status:"all"}) with the
 * same access reference DO collapse to one DB round trip — verified live 2026-08-31 via a
 * request-count probe on the Approvals Hub page. React's cache() in vacation/service.ts already
 * handles this; it was never the reason this module avoids that service.)
 *
 * The deduction figures in this payload come from COMMITTED payroll — salary_records for closed
 * batches, automated_payroll_draft_rows for the in-flight run — and never from
 * deductions_candidates. See the migration header for the measured gap (July 2026: 1,833,169 EGP
 * of candidate estimates against 25,577.65 EGP actually committed, 1.4%).
 */

/**
 * Net and gross only. Deduction figures are deliberately absent from this whole module — owner
 * instruction 2026-08-10: the word must not appear anywhere on his overview.
 */
export type FinanceCommittedMonth = {
  period: string;
  status: string | null;
  employees: number;
  net: number;
  gross: number;
};

export type FinancePayrollRun = {
  month_key: string;
  phase: string | null;
  part1_confirmed: boolean;
  part2_confirmed: boolean;
  published: boolean;
  part2_confirmed_at: string | null;
  rows_in_run: number;
  /** In the run but held out of the payout — never reaches a bank file until cleared. */
  on_hold_count: number;
  expenses_paid: number;
  incentive: number;
};

/**
 * First payment vs second. `one_part` settles entirely in Part 1; everything else (including a
 * NULL, which normalizePayrollPaymentMode defaults to `two_parts`) carries into Part 2.
 */
export type FinancePayrollParts = {
  firstOnlyCount: number;
  firstOnlyNet: number;
  bothPartsCount: number;
  bothPartsNet: number;
};

/**
 * How the money physically leaves: two bank files and the cash desk. Exhaustive and
 * non-overlapping — anyone not on a named bank is Treasury — so the three always reconcile to the
 * standing net beside them.
 */
export type FinancePayoutChannels = {
  fabCount: number;
  fabNet: number;
  cibCount: number;
  cibNet: number;
  treasuryCount: number;
  treasuryNet: number;
};

export type FinanceStatusSlice = { status: string; count: number; value: number };

export type FinanceCommandCenterData = {
  generatedAt: string;
  headcount: {
    activeEmployees: number;
    payrollEligible: number;
    standingNet: number;
    standingGross: number;
    /** Month boundaries are Africa/Cairo, never UTC — a 31st-of-the-month resignation is this month's. */
    resignedThisMonth: number;
    leavingThisMonth: number;
    leaversTotal: number;
  };
  payroll: {
    committed: FinanceCommittedMonth[];
    runs: FinancePayrollRun[];
    parts: FinancePayrollParts;
    channels: FinancePayoutChannels;
  };
  /**
   * The direct-order money pipeline: approved → booked into a sales month → injected into Source
   * of Sales. Only the booking hop is his exclusive duty, and it is the hop nothing else in the
   * product can perform.
   *
   * The pipeline used to carry two more stages — collected and paid — dropped on 2026-08-10 when
   * the owner ruled out collection tracking. At the time they were not fillable at all: the three
   * columns existed on direct_order_requests and were READ in three places, but nothing wrote them.
   * `recordDirectOrderCollection` now does, so the figures would be real if the stages came back —
   * they stay out because the owner asked for the recording and not the dashboard. The RPC still
   * returns `collectedCount` / `paidTotal` / `remainingTotal`; they are simply not modelled here
   * any more, and the extra keys are ignored by the cast in cachedFinanceCommandCenter. Deleting
   * them from the SQL needs a migration against production and buys nothing but a shorter payload,
   * so it is deliberately not part of this change.
   */
  directOrders: {
    awaitingCount: number;
    awaitingValue: number;
    awaitingOldest: string | null;
    approvedCount: number;
    approvedValue: number;
    bookedCount: number;
    bookedValue: number;
    injectedCount: number;
    pendingCount: number;
    pendingValue: number;
    heldCount: number;
    heldValue: number;
    byStatus: FinanceStatusSlice[];
  };
  marketing: {
    awaitingMyStep: number;
    approvedCount: number;
    committedSpend: number;
    requiredRoi: number;
    executedCount: number;
    /** Approved, carrying a pay date, never executed — the queue that means money is owed. */
    dueUnexecutedCount: number;
    dueUnexecutedValue: number;
    dueOldest: string | null;
    inApprovalCount: number;
    missingPaymentProof: number;
    missingInvoice: number;
    /**
     * Approved, the invoice is still owed, and its deadline has passed in Cairo.
     *
     * A DIFFERENT question from the three above it, which is why it is its own figure rather than
     * a refinement of one: `dueUnexecuted` asks whether the money left, `missingInvoice` whether
     * the file is attached. Neither reads `invoice_deadline_date`, so neither can go late. This is
     * the population the nightly nudge (#2695) messages him about, computed from the same two
     * conditions — see the PREDICATE PARITY note in migration 20260830003000.
     *
     * A held invoice is deliberately absent: `hold` means a human paused it on purpose.
     */
    invoiceOverdueCount: number;
    invoiceOverdueValue: number;
    /** The deadline outstanding longest, so the queue's age reads without opening it. */
    invoiceOverdueOldest: string | null;
  };
  leave: { awaitingMyDecision: number };
};

/**
 * Which finance sheets exist for a period. Deliberately NOT folded into the RPC: its gate is
 * `assertAutomatedPayrollFinanceActor`, a role allow-list (CEO / Financial Advisor / Finance
 * Manager / Super Admin) that is independent of the permission matrix. Re-expressing an
 * authorization rule in SQL is how two copies of a rule drift apart, so it stays where it is
 * enforced.
 */
export type FinanceSheetAvailability = {
  period: { month: number; year: number };
  hasRun: boolean;
  part1: boolean;
  full: boolean;
  published: boolean;
};

export type FinanceCommandCenterView = {
  data: FinanceCommandCenterData;
  sheets: FinanceSheetAvailability | null;
  /** Named sources that failed, so the UI can say so rather than render a confident zero. */
  unavailable: string[];
};

const cachedFinanceCommandCenter = unstable_cache(
  async (params: { actorHrId: string; trendMonths: number }): Promise<FinanceCommandCenterData> => {
    const supabase = getSupabaseAdmin();
    const result = await supabase.rpc("phx_finance_command_center", {
      p_actor_hr_id: params.actorHrId || null,
      p_trend_months: params.trendMonths,
    });
    if (result.error) throw result.error;
    return result.data as FinanceCommandCenterData;
  },
  ["finance-command-center"],
  { revalidate: 300, tags: [FINANCE_DASHBOARD_CACHE_TAG] },
);

function emptyData(): FinanceCommandCenterData {
  return {
    generatedAt: new Date().toISOString(),
    headcount: {
      activeEmployees: 0, leaversTotal: 0, leavingThisMonth: 0, payrollEligible: 0,
      resignedThisMonth: 0, standingGross: 0, standingNet: 0,
    },
    payroll: {
      channels: { cibCount: 0, cibNet: 0, fabCount: 0, fabNet: 0, treasuryCount: 0, treasuryNet: 0 },
      committed: [],
      parts: { bothPartsCount: 0, bothPartsNet: 0, firstOnlyCount: 0, firstOnlyNet: 0 },
      runs: [],
    },
    directOrders: {
      approvedCount: 0, approvedValue: 0, awaitingCount: 0, awaitingOldest: null, awaitingValue: 0,
      bookedCount: 0, bookedValue: 0, byStatus: [], heldCount: 0, heldValue: 0,
      injectedCount: 0, pendingCount: 0, pendingValue: 0,
    },
    marketing: {
      approvedCount: 0, awaitingMyStep: 0, committedSpend: 0, dueOldest: null, dueUnexecutedCount: 0,
      dueUnexecutedValue: 0, executedCount: 0, inApprovalCount: 0, invoiceOverdueCount: 0,
      invoiceOverdueOldest: null, invoiceOverdueValue: 0, missingInvoice: 0,
      missingPaymentProof: 0, requiredRoi: 0,
    },
    leave: { awaitingMyDecision: 0 },
  };
}

/** The period whose finance sheets the dashboard offers — the current Cairo month. */
function currentBusinessPeriod(): { month: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    month: "numeric",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(new Date());
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
  return { month, year };
}

export async function getFinanceCommandCenterData(
  access: AccessContext,
  options?: { trendMonths?: number },
): Promise<FinanceCommandCenterView> {
  // The page's own role gate is the boundary; this is the defence-in-depth re-check every
  // finance surface performs. `payroll:read` is the narrowest grant that every tile here sits
  // behind, and it is a portalMinimumPermissions floor, so it cannot be revoked out from under
  // the page by a role_permission_overrides row.
  await assertPermission(access, "payroll", "read");

  const actorHrId = String(access.hrId ?? access.loginId ?? "").trim();
  const trendMonths = Math.max(1, Math.min(24, options?.trendMonths ?? 6));
  const unavailable: string[] = [];

  // Both sources resolve independently so one failing degrades a section instead of the page.
  // A throw here would take out a landing page; a named unavailable source is honest and
  // recoverable. Never swallow into a zero — a confident zero on a money figure is worse than
  // an error, which is the same rule getOutstationExpenseCommandData's callers follow.
  const [payloadResult, sheetsResult] = await Promise.allSettled([
    cachedFinanceCommandCenter({ actorHrId, trendMonths }),
    getFinanceAvailability(access, currentBusinessPeriod()),
  ]);

  let data: FinanceCommandCenterData;
  if (payloadResult.status === "fulfilled" && payloadResult.value) {
    data = payloadResult.value;
  } else {
    data = emptyData();
    unavailable.push("Finance command centre aggregates");
    logError("Finance command center RPC failed", {
      error: payloadResult.status === "rejected" ? payloadResult.reason : new Error("empty payload"),
      labels: { event: "finance_command_center_rpc_failed" },
    });
  }

  let sheets: FinanceSheetAvailability | null = null;
  if (sheetsResult.status === "fulfilled") {
    sheets = { period: currentBusinessPeriod(), ...sheetsResult.value };
  } else {
    unavailable.push("Automated Payroll finance sheets");
    logError("Finance sheet availability failed", {
      error: sheetsResult.reason,
      labels: { event: "finance_command_center_sheets_failed" },
    });
  }

  return { data, sheets, unavailable };
}
