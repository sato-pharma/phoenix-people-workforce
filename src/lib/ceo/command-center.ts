import { getAwaitingMyActionItems } from "@/lib/action-center/service";
import { getSalaryFlags } from "@/lib/admin/service";
import { type AccessContext } from "@/lib/auth/permissions";
import { getAttendanceAnalytics } from "@/lib/attendance/analytics";
import { getApprovedLeaveDayMap } from "@/lib/attendance/working-days";
import { buildCoachingReportAnalytics } from "@/lib/coaching/analytics";
import { getCoachingReports } from "@/lib/coaching/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";
import { getOutstationExpenseCommandData } from "@/lib/outstation/expense-command";
import { getPlatformMetrics, type PlatformMetrics } from "@/lib/platform/metrics";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { loadSourceOfSalesDashboard } from "@/lib/sales/monthly-distributor-import";
import {
  getSalesMarketingDashboard,
  parseSalesMarketingDashboardFilters,
} from "@/lib/sales-marketing-intelligence/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getVacationReportData } from "@/lib/vacation/service";

/**
 * Bespoke executive data layer for the CEO Command Center, split for streaming.
 *
 * `getCeoCommandCenterData` is the FAST executive summary — lean queries only,
 * renders the hero + SoS card + partial attention queue in ~1-2s. Heavy admin
 * aggregators (getAdminCommandCenterData, getOverviewDashboard) have been moved to
 * `getCeoLandingDeferred` so they no longer block first paint.
 *
 * `getCeoLandingDeferred` (Phase B) carries everything else: health breakdown, trends,
 * risk signals, double-visit, expense, attendance, ROI signal, and monthly SoS tables.
 *
 * All sources run via allSettled so one slow/failing domain degrades to "unavailable".
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
    score: number;
    employeeHealthRate: number;
    salesLinkageRate: number;
    attendanceReadinessRate: number;
    salesAchievementRate: number;
  };
  headcount: {
    active: number;
    total: number;
    vacancies: number;
    attritionRate30d: number;
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
  approvals: { leavePending: number | null; plansPending: number | null };
  sos: {
    period: string | null;
    totalValue: number;
    totalQty: number;
    topLines: CeoTopMover[];
    topRegions: CeoTopMover[];
    byRegion: Array<{ label: string; totalValue: number; totalQty: number }>;
    byProduct: Array<{ label: string; totalValue: number; totalQty: number; line: string | null }>;
  } | null;
  trends: {
    sales: Array<{ label: string; sales: number; target: number }>;
    financial: Array<{ label: string; revenue: number; cost: number }>;
    hireExit: Array<{ label: string; hires: number; exits: number }>;
  };
  // Already-computed Phase A admin signals, threaded to the page so it can pass
  // them into Phase B (getCeoLandingDeferred) instead of that phase recomputing
  // the same 6 heavy sub-fetches + getPlatformMetrics a second time. Null only
  // when Phase A's own admin-signals fetch failed — Phase B then retries fresh.
  adminSignals: CeoAdminSignals | null;
};


function topMoversFromSos(
  groups: Array<{ label: string; totalValue: number }> | undefined,
): CeoTopMover[] {
  return [...(groups ?? [])]
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, 5)
    .map((group) => ({ label: group.label, value: group.totalValue }));
}

// ── Lean CEO-specific data helpers ───────────────────────────────────────────
// These are fast targeted queries (no full employee directory, no payroll loops).

function safeRate(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function healthScore(health: CeoAdminSignals["health"]) {
  const values = [
    health.employeeHealthRate,
    health.salesLinkageRate,
    health.attendanceReadinessRate,
    health.salesAchievementRate,
  ].map(safeRate);
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100);
}

async function getCeoProbationCounts(_access: AccessContext): Promise<{ overdue: number; dueSoon: number }> {
  const { data, error } = await getSupabaseAdmin()
    .from("probation_evaluations")
    .select("decision, probation_end_date");
  if (error) throw error;

  const now = Date.now();
  const msPerDay = 86_400_000;
  let overdue = 0;
  let dueSoon = 0;
  for (const row of data ?? []) {
    const decision = row.decision ?? null;
    if (decision === "pass" || decision === "terminate") continue;
    if (!row.probation_end_date) continue;
    const daysRemaining = Math.floor((new Date(row.probation_end_date).getTime() - now) / msPerDay);
    if (daysRemaining < 0) overdue++;
    else if (daysRemaining <= 30) dueSoon++;
  }
  return { overdue, dueSoon };
}

async function getCeoPendingPlansCount(): Promise<number> {
  const { count, error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .select("id", { count: "exact", head: true })
    .eq("status", "manager_approved");
  if (error) throw error;
  return count ?? 0;
}

function buildCeoHealth(
  platformMetrics: PlatformMetrics | null,
  salesLinkageRate: number,
): CeoAdminSignals["health"] {
  return {
    attendanceReadinessRate: safeRate(platformMetrics?.attendance.mappingReadinessRate ?? 0),
    employeeHealthRate: safeRate(platformMetrics?.workforce.employeeHealthRate ?? 0),
    salesAchievementRate: safeRate(platformMetrics?.sales.achievementRate ?? 0),
    salesLinkageRate: safeRate(salesLinkageRate),
  };
}

function buildCeoTrends(
  platformMetrics: PlatformMetrics | null,
  sos: CeoCommandCenterData["sos"] | null,
  departuresLast30d: number,
): CeoCommandCenterData["trends"] {
  const salesValue = sos?.totalValue ?? platformMetrics?.sales.salesValue ?? 0;
  const targetValue = platformMetrics?.sales.targetValue ?? 0;
  const payrollCost = platformMetrics?.payroll.gross ?? 0;
  const payrollLabel = platformMetrics?.payroll.batchLabel && platformMetrics.payroll.batchLabel !== "No batch"
    ? platformMetrics.payroll.batchLabel
    : "Current";
  const periodLabel = sos?.period ?? payrollLabel;

  return {
    sales: salesValue > 0 || targetValue > 0
      ? [{ label: periodLabel, sales: salesValue, target: targetValue }]
      : [],
    financial: salesValue > 0 || payrollCost > 0
      ? [{ label: payrollLabel, revenue: salesValue, cost: payrollCost }]
      : [],
    hireExit: departuresLast30d > 0 || (platformMetrics?.recruitment.acceptedToEmployeeConversions ?? 0) > 0
      ? [{
          label: "Current",
          hires: platformMetrics?.recruitment.acceptedToEmployeeConversions ?? 0,
          exits: departuresLast30d,
        }]
      : [],
  };
}

// ── Fast path: main CEO data (hero + SoS + lean attention) ──────────────────

export async function getCeoCommandCenterData(access: AccessContext): Promise<CeoCommandCenterData> {
  const dataUnavailable: string[] = [];
  const canRestricted = canViewRestrictedProducts(access.role);
  const platformPromise = getPlatformMetrics(access);
  const adminSignalsPromise = platformPromise.then(
    (platformMetrics) => getCeoAdminSignals(access, platformMetrics),
    () => getCeoAdminSignals(access),
  );

  const [sosR, leaveR, platformR, adminSignalsR, pendingPlansR] =
    await Promise.allSettled([
      loadSourceOfSalesDashboard(null, canRestricted),
      getAwaitingMyActionItems(access, "admin"),
      platformPromise,
      adminSignalsPromise,
      getCeoPendingPlansCount(),
    ]);

  const sos = sosR.status === "fulfilled" ? sosR.value : null;
  if (!sos) dataUnavailable.push("Source of Sales (monthly)");
  const leaveItems = leaveR.status === "fulfilled" ? leaveR.value : null;
  if (!leaveItems) dataUnavailable.push("Pending leave approvals");
  const platformMetrics = platformR.status === "fulfilled" ? platformR.value : null;
  if (!platformMetrics) dataUnavailable.push("Platform company metrics");
  if (platformMetrics?.dataUnavailable.length) dataUnavailable.push(...platformMetrics.dataUnavailable);
  const adminSignals = adminSignalsR.status === "fulfilled" ? adminSignalsR.value : null;
  if (!adminSignals) dataUnavailable.push("Executive risk signals");
  if (adminSignals?.dataUnavailable.length) dataUnavailable.push(...adminSignals.dataUnavailable);
  const plansPending = pendingPlansR.status === "fulfilled" ? pendingPlansR.value : null;
  if (pendingPlansR.status === "rejected") dataUnavailable.push("Pending weekly-plan approvals");

  const leavePending = leaveItems ? leaveItems.filter((item) => item.module === "leave").length : null;

  const sosOut = sos
    ? {
        period: sos.period,
        totalValue: sos.totals.totalValue,
        totalQty: sos.totals.totalQty,
        topLines: topMoversFromSos(sos.byLine),
        topRegions: topMoversFromSos(sos.byRegion),
        byRegion: [...sos.byRegion].sort((a, b) => b.totalValue - a.totalValue).map((r) => ({
          label: r.label, totalValue: r.totalValue, totalQty: r.totalQty,
        })),
        byProduct: [...(sos.byProduct ?? [])].sort((a, b) => b.totalValue - a.totalValue).map((p) => ({
          label: p.label, totalValue: p.totalValue, totalQty: p.totalQty, line: (p as { line?: string | null }).line ?? null,
        })),
      }
    : null;
  const workforce = platformMetrics?.workforce;
  const platformPayroll = platformMetrics?.payroll;
  const fallbackHealth = buildCeoHealth(platformMetrics, platformMetrics?.sales.dataQualityRate ?? 0);
  const health = adminSignals?.health ?? fallbackHealth;
  const trends = adminSignals?.trends ?? buildCeoTrends(platformMetrics, sosOut, 0);

  return {
    generatedAt: new Date().toISOString(),
    dataUnavailable: Array.from(new Set(dataUnavailable)),
    health: {
      score: healthScore(health),
      ...health,
    },
    headcount: {
      active: workforce?.activeEmployees ?? 0,
      total: workforce?.totalStructure ?? workforce?.totalEmployees ?? 0,
      vacancies: workforce?.openVacancies ?? 0,
      // Rolling 30-day departures ÷ active headcount (matches admin/command-center.ts).
      // Falls back to 0 when headcount or resignation signals are unavailable; the
      // underlying gaps surface separately via `dataUnavailable`.
      attritionRate30d:
        adminSignals && workforce?.activeEmployees
          ? (adminSignals.departuresLast30d / workforce.activeEmployees) * 100
          : 0,
      uniqueLines: workforce?.uniqueLines ?? 0,
      uniqueAreas: workforce?.uniqueAreas ?? 0,
    },
    payroll: {
      batchLabel: platformPayroll?.batchLabel ?? "No batch",
      gross: platformPayroll?.gross ?? 0,
      net: platformPayroll?.net ?? 0,
      flags: platformPayroll?.flags ?? 0,
      unresolvedSalaryFlags: adminSignals?.payroll.unresolvedSalaryFlags ?? platformPayroll?.flags ?? 0,
      available: Boolean(platformPayroll && (platformPayroll.gross > 0 || platformPayroll.net > 0 || platformPayroll.employees > 0)),
    },
    attention: adminSignals?.attention ?? [],
    approvals: { leavePending, plansPending },
    sos: sosOut,
    trends,
    adminSignals,
  };
}

// ── Phase B: landing-page deferred data ──────────────────────────────────────
// Loads heavy executive widgets behind a second Suspense boundary.
// getAdminCommandCenterData + getOverviewDashboard have been REPLACED with
// getCeoAdminSignals() composes the same service-level aggregate sources used by platform/admin metrics.

async function getCeoAdminSignals(access: AccessContext, platformMetrics?: PlatformMetrics): Promise<CeoAdminSignals> {
  const resolvedPlatformMetrics = platformMetrics ?? await getPlatformMetrics(access);

  const [resignationsR, leavePendingR, contractsActiveR, probationCountsR, coachingR, flagsR] =
    await Promise.allSettled([
      getResignationsDashboardData(access),
      getVacationReportData(access, { status: "all" }),
      getContractRenewalDashboardData(access),
      getCeoProbationCounts(access),
      getCoachingReports({}, access).then(buildCoachingReportAnalytics),
      getSalaryFlags(),
    ]);
  const dataUnavailable: string[] = [];
  if (resignationsR.status === "rejected") dataUnavailable.push("Resignation risk signals");
  if (leavePendingR.status === "rejected") dataUnavailable.push("Leave SLA risk signals");
  if (contractsActiveR.status === "rejected") dataUnavailable.push("Contract renewal risk signals");
  if (probationCountsR.status === "rejected") dataUnavailable.push("Probation risk signals");
  if (coachingR.status === "rejected") dataUnavailable.push("Coaching risk signals");
  if (flagsR.status === "rejected") dataUnavailable.push("Salary flag risk signals");

  const daysFromNow = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return null;
    return Math.floor((time - Date.now()) / 86_400_000);
  };
  const pendingResignations =
    resignationsR.status === "fulfilled" ? resignationsR.value.summary.pending : 0;
  const departuresLast30d =
    resignationsR.status === "fulfilled"
      ? resignationsR.value.records.filter((record) => {
          const delta = daysFromNow(record.effectiveDate);
          return delta !== null && delta <= 0 && delta >= -30;
        }).length
      : 0;
  const overdueLeaveSla =
    leavePendingR.status === "fulfilled"
      ? leavePendingR.value.dashboard.overdueBySla.total || leavePendingR.value.dashboard.pendingByStage.total
      : 0;
  const expiringContracts =
    contractsActiveR.status === "fulfilled"
      ? contractsActiveR.value.rows.filter((row) => {
          const delta = daysFromNow(row.contract_renewal_date);
          return delta !== null && delta >= 0 && delta <= 30;
        }).length
      : resolvedPlatformMetrics.lifecycleRisk.expiringContracts;
  const probationCounts =
    probationCountsR.status === "fulfilled" ? probationCountsR.value : { overdue: 0, dueSoon: 0 };
  const coachingRedZone =
    coachingR.status === "fulfilled"
      ? (coachingR.value.zoneCounts.critical_red ?? 0) + (coachingR.value.zoneCounts.red_zone ?? 0)
      : 0;
  const unresolvedSalaryFlags =
    flagsR.status === "fulfilled" ? flagsR.value.unresolvedCount : resolvedPlatformMetrics.payroll.flags;

  const signalAttention: CeoAttentionItem[] = [];
  if (expiringContracts > 0) {
    signalAttention.push({ key: "contracts", label: "Contracts expiring soon", count: expiringContracts, href: "/contracts", tone: "blue" });
  }
  if (probationCounts.overdue > 0) {
    signalAttention.push({ key: "probationOverdue", label: "Probation decisions overdue", count: probationCounts.overdue, href: "/probation", tone: "rose" });
  }
  if (probationCounts.dueSoon > 0) {
    signalAttention.push({ key: "probationDue", label: "Probation decisions due (30d)", count: probationCounts.dueSoon, href: "/probation", tone: "amber" });
  }
  if (pendingResignations > 0) {
    signalAttention.push({ key: "resignations", label: "Pending resignations", count: pendingResignations, href: "/resignations", tone: "rose" });
  }
  if (overdueLeaveSla > 0) {
    signalAttention.push({ key: "leaveSla", label: "Pending leave approvals", count: overdueLeaveSla, href: "/admin/approvals/vacation", tone: "rose" });
  }
  if (unresolvedSalaryFlags > 0) {
    signalAttention.push({ key: "salaryFlags", label: "Unresolved salary flags", count: unresolvedSalaryFlags, href: "/admin/m-payroll", tone: "rose" });
  }
  if (coachingRedZone > 0) {
    signalAttention.push({ key: "coaching", label: "Coaching red-zone reps", count: coachingRedZone, href: "/coaching", tone: "amber" });
  }

  const health = buildCeoHealth(resolvedPlatformMetrics, resolvedPlatformMetrics.sales.dataQualityRate);
  const trends = buildCeoTrends(resolvedPlatformMetrics, null, departuresLast30d);
  const payroll = resolvedPlatformMetrics.payroll;

  return {
    attention: signalAttention,
    dataUnavailable: Array.from(new Set(dataUnavailable)),
    departuresLast30d,
    health,
    trends,
    payroll: {
      batchLabel: payroll.batchLabel,
      gross: payroll.gross,
      net: payroll.net,
      unresolvedSalaryFlags,
    },
  };
}

export type CeoDvManagerRow = {
  managerHrId: string;
  managerName: string;
  role: string | null;
  roleCode: string | null;
  lineName: string | null;
  distinctMrs: number;
  overFocusedMrCount: number;
  neglectedMrCount: number | null;
  neglectIndex: number | null;
  teamMrCount: number | null;
  daysSinceLastDv: number | null;
  coveragePct: number | null;
};

export type CeoRoiSignal = {
  startedStrong: number;
  startedWeak: number;
  stillZero: number;
  lastPeriod: string | null;
  trend: Array<{ period: string; onTrack: number; behind: number; noData: number }>;
};

export type CeoAdminSignals = {
  attention: CeoAttentionItem[];
  dataUnavailable: string[];
  /** Rolling 30-day departures (resignations effective within the last 30 days); 0 if resignation data is unavailable. */
  departuresLast30d: number;
  health: {
    salesLinkageRate: number;
    attendanceReadinessRate: number;
    salesAchievementRate: number;
    employeeHealthRate: number;
  };
  trends: {
    sales: Array<{ label: string; sales: number; target: number }>;
    financial: Array<{ label: string; revenue: number; cost: number }>;
    hireExit: Array<{ label: string; hires: number; exits: number }>;
  };
  payroll: {
    batchLabel: string;
    gross: number;
    net: number;
    unresolvedSalaryFlags: number;
  };
};

export type CeoLandingDeferredData = {
  dataUnavailable: string[];
  doubleVisit: {
    managerRows: CeoDvManagerRow[];
    dateFrom: string;
    dateTo: string;
  } | null;
  expense: {
    totalAmount: number;
    approvedPct: number;
    highRiskCount: number | null;
    windowLabel: string;
    byRegion: Array<{ label: string; amount: number }>;
    topSpenders: Array<{ label: string; amount: number }>;
  } | null;
  roiSignal: CeoRoiSignal | null;
  attendance: {
    todayIsWorkingDay: boolean;
    todayAbsentees: Array<{ hrId: string; name: string; department: string }>;
    weeklyTrend: Array<{ isoWeek: string; lateRate: number; absenceRate: number }>;
    chronicLate: Array<{ hrId: string; name: string; lateDays: number; lateRate: number }>;
  } | null;
  managersOnLeave: Array<{ name: string; hrId: string; role: string }> | null;
  adminSignals: CeoAdminSignals | null;
};

export async function getCeoLandingDeferred(
  access: AccessContext,
  prefetchedAdminSignals?: CeoAdminSignals | null,
): Promise<CeoLandingDeferredData> {
  const dataUnavailable: string[] = [];

  // Run all heavy sources concurrently. SoS is NOT re-fetched here — the fast path
  // already loads it and passes byRegion/byProduct via sosPrefetched prop on the page.
  // getCeoAdminSignals() replaces the old getAdminCommandCenterData + getOverviewDashboard
  // with CEO-safe service aggregates.
  // adminSignals is likewise reused from the fast path when it succeeded there (avoids
  // recomputing the same 6 heavy sub-fetches + getPlatformMetrics a second time per page
  // load); only re-fetched here if the fast path didn't compute it or its fetch failed.
  const [dvR, expenseR, attendanceR, marketingR, adminSignalsR] = await Promise.allSettled([
    getDoubleVisitDashboardData({ access }),
    getOutstationExpenseCommandData(access, { preset: "30d" }),
    getAttendanceAnalytics(),
    getSalesMarketingDashboard(access, parseSalesMarketingDashboardFilters({})),
    prefetchedAdminSignals ? Promise.resolve(prefetchedAdminSignals) : getCeoAdminSignals(access),
  ]);

  const dv = dvR.status === "fulfilled" ? dvR.value : null;
  if (!dv) dataUnavailable.push("Double-Visit Intelligence");
  const expense = expenseR.status === "fulfilled" ? expenseR.value : null;
  if (!expense) dataUnavailable.push("Expense Snapshot");
  const attendance = attendanceR.status === "fulfilled" ? attendanceR.value : null;
  if (!attendance) dataUnavailable.push("Attendance Analytics");
  const marketing = marketingR.status === "fulfilled" ? marketingR.value : null;
  if (!marketing) dataUnavailable.push("ROI Signal");
  const adminSignals = adminSignalsR.status === "fulfilled" ? adminSignalsR.value : null;
  if (!adminSignals) dataUnavailable.push("Executive risk signals");
  if (adminSignals?.dataUnavailable.length) dataUnavailable.push(...adminSignals.dataUnavailable);

  // Double-visit manager rows
  const dvOut = dv
    ? {
        managerRows: dv.managerSummaries.map((s) => ({
          managerHrId: s.managerHrId,
          managerName: s.managerName,
          role: s.role ?? null,
          roleCode: s.roleCode ?? null,
          lineName: s.lineName ?? null,
          distinctMrs: s.distinctMrs,
          overFocusedMrCount: s.overFocusedMrCount,
          neglectedMrCount: s.neglectedMrCount ?? null,
          neglectIndex:
            s.neglectedMrCount != null && s.teamMrCount
              ? Math.round((s.neglectedMrCount / s.teamMrCount) * 100) / 100
              : null,
          teamMrCount: s.teamMrCount ?? null,
          daysSinceLastDv: s.daysSinceLastDv ?? null,
          coveragePct: s.coveragePct ?? null,
        })),
        dateFrom: dv.dateFrom,
        dateTo: dv.dateTo,
      }
    : null;

  // Managers on leave today — derive from DV manager list + leave map
  let managersOnLeave: CeoLandingDeferredData["managersOnLeave"] = null;
  if (dv && dv.managerSummaries.length > 0) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const hrIds = dv.managerSummaries.map((s) => s.managerHrId).filter(Boolean);
    try {
      const leaveMap = await getApprovedLeaveDayMap({
        dateFromIso: todayIso,
        dateToIso: todayIso,
        employeeHrIds: hrIds,
      });
      managersOnLeave = dv.managerSummaries
        .filter((s) => {
          const key = s.managerHrId.toUpperCase();
          for (const [k, dates] of leaveMap) {
            if (k.toUpperCase() === key && dates.has(todayIso)) return true;
          }
          return false;
        })
        .map((s) => ({
          hrId: s.managerHrId,
          name: s.managerName,
          role: s.role ?? s.roleCode ?? "Manager",
        }));
    } catch {
      managersOnLeave = [];
    }
  }

  // Expense snippet
  const expenseOut = expense
    ? {
        totalAmount: expense.kpis.totalAmount,
        approvedPct:
          expense.kpis.totalAmount > 0 ? expense.kpis.approvedAmount / expense.kpis.totalAmount : 0,
        highRiskCount: expense.kpis.highRiskRows,
        windowLabel: expense.windowLabel,
        byRegion: expense.breakdowns.byRegion.slice(0, 7).map((r) => ({ label: r.key, amount: r.total })),
        topSpenders: expense.leaderboards.topSpenders
          .slice(0, 5)
          .map((s) => ({ label: s.name, amount: s.total })),
      }
    : null;

  // ROI signal — bucket by most recent period's counts
  const roiSignalOut: CeoRoiSignal | null = marketing
    ? (() => {
        const trend = marketing.roiTrend ?? [];
        const last = trend.length > 0 ? trend[trend.length - 1] : null;
        return {
          startedStrong: last?.onTrackCount ?? 0,
          startedWeak: last?.behindCount ?? 0,
          stillZero: last?.noDataCount ?? 0,
          lastPeriod: last?.period ?? null,
          trend: trend.slice(-6).map((p) => ({
            period: p.period,
            onTrack: p.onTrackCount,
            behind: p.behindCount,
            noData: p.noDataCount,
          })),
        };
      })()
    : null;

  // Attendance
  const attendanceOut = attendance
    ? {
        todayIsWorkingDay: attendance.today.isWorkingDay,
        todayAbsentees: attendance.today.absentees.map((a) => ({
          hrId: a.employeeHrId,
          name: a.employeeName,
          department: a.department,
        })),
        weeklyTrend: attendance.weeklyTrend.slice(-7).map((w) => ({
          isoWeek: w.isoWeek,
          lateRate: w.lateRate,
          absenceRate: w.absenceRate,
        })),
        chronicLate: attendance.chronicLate.slice(0, 10).map((c) => ({
          hrId: c.employeeHrId,
          name: c.employeeName,
          lateDays: c.lateDays,
          lateRate: c.lateRate,
        })),
      }
    : null;

  return {
    dataUnavailable: Array.from(new Set(dataUnavailable)),
    doubleVisit: dvOut,
    expense: expenseOut,
    roiSignal: roiSignalOut,
    attendance: attendanceOut,
    managersOnLeave,
    adminSignals,
  };
}
