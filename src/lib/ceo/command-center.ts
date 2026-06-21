import { getAwaitingMyActionItems } from "@/lib/action-center/service";
import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { createAccessContext, type AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { getOverviewDashboard } from "@/lib/overview/service";
import { getProbationRows } from "@/lib/probation/service";
import { getVacancyReport } from "@/lib/reports/vacancies";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { loadSourceOfSalesDashboard } from "@/lib/sales/monthly-distributor-import";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import {
  getSalesMarketingDashboardSnapshot,
  parseSalesMarketingDashboardFilters,
} from "@/lib/sales-marketing-intelligence/service";
import { getEmployeePlansWorkspace } from "@/lib/weekly-planning/service";

/**
 * Bespoke executive data layer for the CEO Command Center, split for streaming.
 *
 * `getCeoCommandCenterData` is the FAST executive summary (health, headcount, payroll,
 * attention, approvals, Source of Sales, trends) — every source resolves in a few
 * seconds. `getCeoSalesDeferred` carries the two heavy aggregators (Weekly Sales and
 * Marketing ROI, ~15s each against prod) so the page can render the summary immediately
 * and stream those cards in behind a Suspense boundary instead of blocking ~16s on them.
 *
 * Both run their sources via allSettled so one slow/failing domain degrades to a
 * labelled "unavailable" rather than blanking the page. CEO/Super Admin see confidential
 * products (LA003/LA004/SS001) across Sales — the page is gated to them.
 */

export type CeoTopMover = { label: string; value: number };
export type CeoAttentionTone = "rose" | "amber" | "blue";
export type CeoAttentionItem = {
  key: string;
  label: string;
  count: number;
  href: string;
  tone: CeoAttentionTone;
};

export type CeoCommandCenterData = {
  generatedAt: string;
  dataUnavailable: string[];
  health: {
    score: number; // 0..100
    employeeHealthRate: number; // 0..1
    salesLinkageRate: number; // 0..1
    attendanceReadinessRate: number; // 0..1
    salesAchievementRate: number; // 0..1
  };
  headcount: {
    active: number;
    total: number;
    vacancies: number;
    attritionRate30d: number; // percentage
    uniqueLines: number;
    uniqueAreas: number;
  };
  payroll: {
    batchLabel: string;
    gross: number;
    net: number;
    flags: number;
    unresolvedSalaryFlags: number;
    available: boolean;
  };
  attention: CeoAttentionItem[];
  approvals: { leavePending: number; plansPending: number };
  sos: {
    period: string | null;
    totalValue: number;
    totalQty: number;
    topLines: CeoTopMover[];
    topRegions: CeoTopMover[];
  } | null;
  trends: {
    sales: Array<{ label: string; sales: number; target: number }>;
    financial: Array<{ label: string; revenue: number; cost: number }>;
    hireExit: Array<{ label: string; hires: number; exits: number }>;
  };
};

export type CeoSalesDeferredData = {
  dataUnavailable: string[];
  weekly: {
    weekStart: string | null;
    salesValue: number;
    salesUnits: number;
    wowPct: number | null;
    wowPriorMissing: boolean;
    trend: CeoTopMover[];
    topRegions: CeoTopMover[];
  } | null;
  marketing: {
    totalCost: number;
    attributedSalesValue: number;
    roiCoverage: number; // 0..1 fraction
    actionRequired: number;
    spendAtRisk: number;
    requestCount: number;
    paidRequests: number;
    behindRequests: number;
    topRisk: { customer: string; code: string; action: string } | null;
  } | null;
};

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function topMoversFromSos(
  groups: Array<{ label: string; totalValue: number }> | undefined,
): CeoTopMover[] {
  return [...(groups ?? [])]
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, 5)
    .map((group) => ({ label: group.label, value: group.totalValue }));
}

export async function getCeoCommandCenterData(access: AccessContext): Promise<CeoCommandCenterData> {
  const dataUnavailable: string[] = [];
  const canRestricted = canViewRestrictedProducts(access.role);

  // The CEO command center is gated to CEO + Super Admin and shows COMPANY-WIDE
  // executive figures. Headcount / vacancies / probation must NOT be narrowed by the
  // CEO's self-only employee-row visibility — that restriction protects the salary-bearing
  // employee master, not aggregate counts (same reason the organogram is unfiltered for the
  // CEO). So pull people/org figures from company-wide sources: the unfiltered directory
  // rows + vacancy report, and probation via an elevated read.
  const companyView = createAccessContext({ hrId: access.hrId, role: "Super Admin" });

  const [adminR, overviewR, sosR, leaveR, plansR, probationR, directoryR, vacancyR] = await Promise.allSettled([
    getAdminCommandCenterData(access),
    getOverviewDashboard(access),
    loadSourceOfSalesDashboard(null, canRestricted),
    getAwaitingMyActionItems(access, "admin"),
    getEmployeePlansWorkspace(access),
    getProbationRows(companyView),
    getEmployeeDirectoryRows(),
    getVacancyReport(),
  ]);

  const admin = adminR.status === "fulfilled" ? adminR.value : null;
  if (!admin) dataUnavailable.push("Executive signals");
  const overview = overviewR.status === "fulfilled" ? overviewR.value : null;
  if (!overview) dataUnavailable.push("Overview trends");
  const sos = sosR.status === "fulfilled" ? sosR.value : null;
  if (!sos) dataUnavailable.push("Source of Sales (monthly)");
  const leaveItems = leaveR.status === "fulfilled" ? leaveR.value : null;
  if (!leaveItems) dataUnavailable.push("Pending leave approvals");
  const plans = plansR.status === "fulfilled" ? plansR.value : null;
  if (!plans) dataUnavailable.push("Pending plan approvals");
  const probationRows = probationR.status === "fulfilled" ? probationR.value : null;
  if (!probationRows) dataUnavailable.push("Probation");
  const directoryRows = directoryR.status === "fulfilled" ? directoryR.value : null;
  if (!directoryRows) dataUnavailable.push("Headcount");
  const vacancyReport = vacancyR.status === "fulfilled" ? vacancyR.value : null;
  if (!vacancyReport) dataUnavailable.push("Vacancies");
  if (admin?.dataUnavailable?.length) dataUnavailable.push(...admin.dataUnavailable);

  // Company-wide headcount + structure from the unfiltered directory (not access-scoped).
  const activeStaff = (directoryRows ?? []).filter((row) =>
    ["active", "on_leave"].includes(String(row.employmentStatus ?? "active").toLowerCase()),
  );
  const activeHeadcount = activeStaff.length;
  const openVacancies = vacancyReport?.summary.openVacancies ?? 0;
  const uniqueLines = new Set(activeStaff.map((row) => row.lineName).filter(Boolean)).size;
  const uniqueAreas = new Set(activeStaff.map((row) => row.areaName).filter(Boolean)).size;
  // Company "health" proxy (admin.health.employeeHealthRate is CEO-self-only → bogus 100%).
  const companyEmployeeHealthRate = activeHeadcount
    ? activeStaff.filter((row) => row.managerHrId).length / activeHeadcount
    : 0;

  const exec = admin?.overview.executive;
  const risk = admin?.overview.risk;
  // Probation, computed from the real rows (the platform's default risk metric only
  // counts the next 0–15 days and drops past-due cases — surface overdue + due-30d here).
  const openProbation = (probationRows ?? []).filter(
    (row) => row.workflow?.decision !== "pass" && row.workflow?.decision !== "terminate",
  );
  const probationOverdue = openProbation.filter(
    (row) => typeof row.days_remaining === "number" && row.days_remaining < 0,
  ).length;
  const probationDueSoon = openProbation.filter(
    (row) => typeof row.days_remaining === "number" && row.days_remaining >= 0 && row.days_remaining <= 30,
  ).length;

  // ── Company health score (transparent weighted blend of real rates) ──────────
  const employeeHealthRate = companyEmployeeHealthRate;
  const salesLinkageRate = admin?.health.salesLinkageRate ?? 0;
  const attendanceReadinessRate = admin?.health.attendanceReadinessRate ?? 0;
  const salesAchievementRate = overview?.sales.achievementRate ?? admin?.overview.sales.achievementRate ?? 0;
  const score = Math.round(
    (clamp01(salesAchievementRate / 0.9) * 0.3 +
      clamp01(attendanceReadinessRate) * 0.2 +
      clamp01(employeeHealthRate) * 0.25 +
      clamp01(salesLinkageRate) * 0.15 +
      clamp01(1 - Math.min(1, dataUnavailable.length * 0.08)) * 0.1) *
      100,
  );

  // ── Attention queue (only surfaces items that actually need the CEO's eye) ────
  const attention: CeoAttentionItem[] = [];
  if (risk?.expiringContracts) {
    attention.push({ key: "contracts", label: "Contracts expiring soon", count: risk.expiringContracts, href: "/contracts", tone: "blue" });
  }
  if (probationOverdue) {
    attention.push({ key: "probationOverdue", label: "Probation decisions overdue", count: probationOverdue, href: "/probation", tone: "rose" });
  }
  if (probationDueSoon) {
    attention.push({ key: "probationDue", label: "Probation decisions due (30d)", count: probationDueSoon, href: "/probation", tone: "amber" });
  }
  if (exec?.pendingResignations) {
    attention.push({ key: "resignations", label: "Pending resignations", count: exec.pendingResignations, href: "/resignations", tone: "rose" });
  }
  if (exec?.overdueLeaveSla) {
    attention.push({ key: "leaveSla", label: "Overdue leave approvals", count: exec.overdueLeaveSla, href: "/admin/action-center", tone: "rose" });
  }
  if (admin?.unresolvedSalaryFlags) {
    attention.push({ key: "salaryFlags", label: "Unresolved salary flags", count: admin.unresolvedSalaryFlags, href: "/payroll", tone: "rose" });
  }
  if (exec?.coachingRedZone) {
    attention.push({ key: "coaching", label: "Coaching red-zone reps", count: exec.coachingRedZone, href: "/coaching", tone: "amber" });
  }

  const leavePending = leaveItems ? leaveItems.filter((item) => item.module === "leave").length : 0;
  const plansPending = plans?.summary.ceoPending ?? 0;

  const sosOut = sos
    ? {
        period: sos.period,
        totalValue: sos.totals.totalValue,
        totalQty: sos.totals.totalQty,
        topLines: topMoversFromSos(sos.byLine),
        topRegions: topMoversFromSos(sos.byRegion),
      }
    : null;

  return {
    generatedAt: admin?.generatedAt ?? new Date().toISOString(),
    dataUnavailable: Array.from(new Set(dataUnavailable)),
    health: {
      score,
      employeeHealthRate,
      salesLinkageRate,
      attendanceReadinessRate,
      salesAchievementRate,
    },
    headcount: {
      active: activeHeadcount,
      total: activeHeadcount,
      vacancies: openVacancies,
      attritionRate30d: exec?.attritionRate30d ?? 0,
      uniqueLines,
      uniqueAreas,
    },
    payroll: {
      batchLabel: admin?.overview.payroll.batchLabel ?? "—",
      gross: admin?.overview.payroll.gross ?? 0,
      net: admin?.overview.payroll.net ?? 0,
      flags: admin?.overview.payroll.flags ?? 0,
      unresolvedSalaryFlags: admin?.unresolvedSalaryFlags ?? 0,
      available: admin?.access.showFinancialModules ?? false,
    },
    attention,
    approvals: { leavePending, plansPending },
    sos: sosOut,
    trends: {
      sales: (overview?.sales.trend ?? []).map((point) => ({ label: point.period, sales: point.sales, target: point.target })),
      financial: (overview?.financial.trend ?? []).map((point) => ({ label: point.month, revenue: point.revenue, cost: point.cost })),
      hireExit: (overview?.hr.hireExitTrend ?? []).map((point) => ({ label: point.m, hires: point.h, exits: point.e })),
    },
  };
}

/**
 * The two heavy Sales aggregators (Weekly Sales + Marketing ROI, ~15s each against prod),
 * loaded separately so the page streams them behind a Suspense boundary.
 */
export async function getCeoSalesDeferred(access: AccessContext): Promise<CeoSalesDeferredData> {
  const dataUnavailable: string[] = [];

  const [weeklyR, marketingR] = await Promise.allSettled([
    resolveWeeklyAccessScope(access).then((accessScope) => loadWeeklyDashboard({ accessScope })),
    getSalesMarketingDashboardSnapshot(access, parseSalesMarketingDashboardFilters({})),
  ]);

  const weekly = weeklyR.status === "fulfilled" ? weeklyR.value : null;
  if (!weekly) dataUnavailable.push("Weekly Sales");
  const marketing = marketingR.status === "fulfilled" ? marketingR.value : null;
  if (!marketing) dataUnavailable.push("Marketing ROI");

  const weeklyOut = weekly
    ? {
        weekStart: weekly.weekStart,
        salesValue: weekly.kpis.salesValue,
        salesUnits: weekly.kpis.salesUnits,
        wowPct: weekly.compare.salesValue.pct,
        wowPriorMissing: weekly.compare.salesValue.prior === null,
        trend: (weekly.trend ?? []).map((point) => ({ label: point.weekStart, value: point.salesValue })),
        topRegions: [...(weekly.regions ?? [])]
          .sort((a, b) => b.salesValue - a.salesValue)
          .slice(0, 5)
          .map((region) => ({ label: region.name, value: region.salesValue })),
      }
    : null;

  const topRisk = marketing?.decisionSummary.topRiskRequest ?? null;
  const marketingOut = marketing
    ? {
        totalCost: marketing.summary.totalMarketingCost,
        attributedSalesValue: marketing.summary.actualAttributedSalesValue,
        roiCoverage: marketing.summary.actualRoiCoverage,
        actionRequired: marketing.summary.actionRequiredRequests,
        spendAtRisk: marketing.summary.spendAtRisk,
        requestCount: marketing.summary.marketingRequestCount,
        paidRequests: marketing.summary.paidRequestCount,
        behindRequests: marketing.summary.behindRequests,
        topRisk: topRisk
          ? { customer: topRisk.customerName, code: topRisk.requestCode, action: topRisk.recommendedAction }
          : null,
      }
    : null;

  return { dataUnavailable, weekly: weeklyOut, marketing: marketingOut };
}
