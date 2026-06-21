import { getAwaitingMyActionItems } from "@/lib/action-center/service";
import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import type { AccessContext } from "@/lib/auth/permissions";
import { getOverviewDashboard } from "@/lib/overview/service";
import { getProbationRows } from "@/lib/probation/service";
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
 * Bespoke executive data layer for the CEO Command Center. Composes the existing
 * domain aggregators (admin command center, overview, Source of Sales, Weekly Sales,
 * Marketing ROI, pending approvals) into ONE executive snapshot. Every source is run
 * via allSettled so one slow/failing domain degrades to a labelled "unavailable"
 * rather than blanking the page or showing a misleading zero. CEO/Super Admin see
 * confidential products (LA003/LA004/SS001) across Sales — the page is gated to them.
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
  sales: {
    sos: {
      period: string | null;
      totalValue: number;
      totalQty: number;
      topLines: CeoTopMover[];
      topRegions: CeoTopMover[];
    } | null;
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
      roiCoverage: number; // percentage
      actionRequired: number;
      spendAtRisk: number;
      requestCount: number;
      paidRequests: number;
      behindRequests: number;
      topRisk: { customer: string; code: string; action: string } | null;
    } | null;
  };
  trends: {
    sales: Array<{ label: string; sales: number; target: number }>;
    financial: Array<{ label: string; revenue: number; cost: number }>;
    hireExit: Array<{ label: string; hires: number; exits: number }>;
  };
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

  const [adminR, overviewR, sosR, weeklyR, marketingR, leaveR, plansR, probationR] = await Promise.allSettled([
    getAdminCommandCenterData(access),
    getOverviewDashboard(access),
    loadSourceOfSalesDashboard(null, canRestricted),
    resolveWeeklyAccessScope(access).then((accessScope) => loadWeeklyDashboard({ accessScope })),
    getSalesMarketingDashboardSnapshot(access, parseSalesMarketingDashboardFilters({})),
    getAwaitingMyActionItems(access, "admin"),
    getEmployeePlansWorkspace(access),
    getProbationRows(access),
  ]);

  const admin = adminR.status === "fulfilled" ? adminR.value : null;
  if (!admin) dataUnavailable.push("Executive signals");
  const overview = overviewR.status === "fulfilled" ? overviewR.value : null;
  if (!overview) dataUnavailable.push("Overview trends");
  const sos = sosR.status === "fulfilled" ? sosR.value : null;
  if (!sos) dataUnavailable.push("Source of Sales (monthly)");
  const weekly = weeklyR.status === "fulfilled" ? weeklyR.value : null;
  if (!weekly) dataUnavailable.push("Weekly Sales");
  const marketing = marketingR.status === "fulfilled" ? marketingR.value : null;
  if (!marketing) dataUnavailable.push("Marketing ROI");
  const leaveItems = leaveR.status === "fulfilled" ? leaveR.value : null;
  if (!leaveItems) dataUnavailable.push("Pending leave approvals");
  const plans = plansR.status === "fulfilled" ? plansR.value : null;
  if (!plans) dataUnavailable.push("Pending plan approvals");
  const probationRows = probationR.status === "fulfilled" ? probationR.value : null;
  if (!probationRows) dataUnavailable.push("Probation");
  if (admin?.dataUnavailable?.length) dataUnavailable.push(...admin.dataUnavailable);

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
  const employeeHealthRate = admin?.health.employeeHealthRate ?? overview?.hr.employeeHealthRate ?? 0;
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
      active: admin?.overview.hr.activeEmployees ?? overview?.hr.activeEmployees ?? 0,
      total: admin?.overview.hr.totalEmployees ?? overview?.hr.totalEmployees ?? 0,
      vacancies: admin?.overview.hr.vacantPositions ?? overview?.vacancies.openVacancies ?? 0,
      attritionRate30d: exec?.attritionRate30d ?? 0,
      uniqueLines: admin?.overview.hr.uniqueLines ?? overview?.hr.uniqueLines ?? 0,
      uniqueAreas: admin?.overview.hr.uniqueAreas ?? overview?.hr.uniqueAreas ?? 0,
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
    sales: { sos: sosOut, weekly: weeklyOut, marketing: marketingOut },
    trends: {
      sales: (overview?.sales.trend ?? []).map((point) => ({ label: point.period, sales: point.sales, target: point.target })),
      financial: (overview?.financial.trend ?? []).map((point) => ({ label: point.month, revenue: point.revenue, cost: point.cost })),
      hireExit: (overview?.hr.hireExitTrend ?? []).map((point) => ({ label: point.m, hires: point.h, exits: point.e })),
    },
  };
}
