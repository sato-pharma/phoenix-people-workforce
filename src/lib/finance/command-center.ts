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
 * getMarketingRequestDraftWorkspace is an 11-query Promise.all, getVacationWorkspaceData fetches
 * the company leave report twice per call. So the aggregation lives in Postgres and comes back
 * assembled.
 *
 * The deduction figures in this payload come from COMMITTED payroll — salary_records for closed
 * batches, automated_payroll_draft_rows for the in-flight run — and never from
 * deductions_candidates. See the migration header for the measured gap (July 2026: 1,833,169 EGP
 * of candidate estimates against 25,577.65 EGP actually committed, 1.4%).
 */

export type FinanceCommittedMonth = {
  period: string;
  status: string | null;
  employees: number;
  net: number;
  gross: number;
  /** What payroll actually deducted — NOT what the detection engines suggested. */
  deductions: number;
  /** Tax + insurance. Reported apart from HR deductions so neither figure implies the other. */
  governmental: number;
  crm: number;
  fingerprint: number;
  unpaid_vacation: number;
  loans: number;
  other: number;
};

export type FinancePayrollRun = {
  month_key: string;
  phase: string | null;
  part1_confirmed: boolean;
  part2_confirmed: boolean;
  published: boolean;
  part2_confirmed_at: string | null;
  rows_in_run: number;
  decided_deductions: number;
  expenses_paid: number;
  incentive: number;
};

export type FinanceStatusSlice = { status: string; count: number; value: number };

export type FinanceCommandCenterData = {
  generatedAt: string;
  headcount: {
    activeEmployees: number;
    payrollEligible: number;
    standingNet: number;
    standingGross: number;
  };
  payroll: { committed: FinanceCommittedMonth[]; runs: FinancePayrollRun[] };
  /**
   * The direct-order money pipeline: approved → booked into a sales month → injected into Source
   * of Sales → collected → paid. Only the booking hop is his exclusive duty, but the rest is the
   * receivable that duty creates. The collection fields read 0 today and fill as collection starts.
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
    collectedCount: number;
    paidTotal: number;
    remainingTotal: number;
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
    headcount: { activeEmployees: 0, payrollEligible: 0, standingNet: 0, standingGross: 0 },
    payroll: { committed: [], runs: [] },
    directOrders: {
      approvedCount: 0, approvedValue: 0, awaitingCount: 0, awaitingOldest: null, awaitingValue: 0,
      bookedCount: 0, bookedValue: 0, byStatus: [], collectedCount: 0, heldCount: 0, heldValue: 0,
      injectedCount: 0, paidTotal: 0, pendingCount: 0, pendingValue: 0, remainingTotal: 0,
    },
    marketing: {
      approvedCount: 0, awaitingMyStep: 0, committedSpend: 0, dueOldest: null, dueUnexecutedCount: 0,
      dueUnexecutedValue: 0, executedCount: 0, inApprovalCount: 0, missingInvoice: 0,
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
