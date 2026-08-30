import { getSalaryFlags } from "@/lib/admin/service";
import { hrIdsMatch, type AccessContext } from "@/lib/auth/permissions";
import { getAttendanceAnalytics } from "@/lib/attendance/analytics";
import { getApprovedLeaveDayMap } from "@/lib/attendance/working-days";
import { buildCoachingReportAnalytics } from "@/lib/coaching/analytics";
import { getCoachingReports } from "@/lib/coaching/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { getSfeCrmFieldAnalytics, type SfeCrmFieldAnalytics } from "@/lib/crm/sfe-field-analytics";
import { getSfeDoctorCoverage, type SfeDoctorCoverageBoard } from "@/lib/crm/sfe-doctor-coverage";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";
import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { getOutstationExpenseCommandData } from "@/lib/outstation/expense-command";
import { getPlatformMetrics, type PlatformMetrics } from "@/lib/platform/metrics";
import { getProbationRows, isProbationDecisionOutstanding } from "@/lib/probation/service";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { latestPublishedClosingPeriod } from "@/lib/sales/monthly-closing-publication";
import { loadSourceOfSalesDashboard } from "@/lib/sales/monthly-distributor-import";
import {
  getSfeImsContribution,
  getSfeTargetPerformance,
  type SfeImsContribution,
  type SfeTargetPerformance,
} from "@/lib/sales/sfe-performance";
import { getPortalWeeklyDashboard } from "@/lib/sales/weekly/portal-weekly-dashboard";
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
    /**
     * Why `period` is the month it is — so the card can SAY which month it is showing instead of
     * quietly swapping one for another.
     *
     * `published-closing` — the last month with a published closing, the normal case.
     * `latest-upload`     — nothing has ever been published (or the lookup failed), so this is the
     *                       newest month holding data, exactly as before this field existed.
     */
    periodBasis: "published-closing" | "latest-upload";
    /**
     * Months NEWER than the one shown that already hold data but are not closed yet, newest first.
     *
     * Without this the card would be silent about a month in progress, and "August is loading" is
     * not a detail — it is the difference between a number that is deliberately last month's and a
     * system that looks stuck. Empty whenever the newest month is the one on display.
     */
    newerPeriods: string[];
    totalValue: number;
    totalQty: number;
    /**
     * Lines and regions carrying sales this period, counted from the SoS dataset itself.
     *
     * The headcount block's uniqueLines/uniqueAreas come from the employee directory, which is
     * gated by canReadCompanyWorkforceAggregates (system scope, Super Admin, or CEO) — every
     * other role reads a hard zero rather than an error. These counts are sales data, so they
     * are real for anyone who can see the SoS dashboard at all.
     */
    lineCount: number;
    regionCount: number;
    topLines: CeoTopMover[];
    topRegions: CeoTopMover[];
    /** Every line with sales this period (not just the top movers) — the basis for line scoping. */
    byLine: Array<{ label: string; totalValue: number; totalQty: number }>;
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

/**
 * How the SoS month is named wherever it appears — hero tiles, card header, table titles, export
 * titles. One helper because those live in three components: two of them would otherwise each grow
 * their own copy of this string and drift, and the owner's rule is that an export must match the
 * screen it came from.
 *
 * Pure and null-safe by design, so a client component can be handed the finished string.
 */
export function sosPeriodDisplayLabel(sos: CeoCommandCenterData["sos"]): string | null {
  if (!sos?.period) return null;
  // Never call an unclosed month a closing. When nothing has been published the card is simply
  // showing the newest data loaded, and saying so is the difference between a figure the reader
  // can bank and one they should not.
  return sos.periodBasis === "published-closing"
    ? `${sos.period} closing`
    : `${sos.period} · not closed yet`;
}

/**
 * Product lines the SFE partitions (targets, IMS contribution) are computed over.
 *
 * The confidential Head Office line is NO LONGER stripped here: loadSourceOfSalesDashboard now
 * takes the viewer and derives canViewHeadOfficeLine itself (#1617), so every dimension including
 * the geo rollups arrives already correct and a caller cannot forget the lock. This list remains
 * only to scope the target and IMS partitions, which read their own datasets.
 */
const SFE_VISIBLE_LINES = ["CNS", "Pedia", "Anti Infective"] as const;

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

/**
 * Probation decisions still open, counted from the rows /probation renders.
 *
 * An attention item is a LINK, so its number has to describe the page it opens.
 * This used to scan probation_evaluations directly for records whose
 * probation_end_date had passed and label them "overdue" — but getProbationRows,
 * the service behind the tracker this links to, ends with `days_remaining > 0`,
 * so that figure counted exactly the people the destination table cannot contain:
 * the CEO clicked 22 and landed on a list holding none of them. The raw scan also
 * never applied the tracker's medical-representative rule, so head-office roles
 * were billed as outstanding decisions. Sourcing the count from the tracker's own
 * service removes that at once and keeps the viewer's scope, which the
 * admin-client scan bypassed.
 *
 * The employment-status rule is still applied HERE and not inherited, because
 * getProbationRows deliberately does not apply one: it is built from the employee
 * directory's hire+90 window, the tracker's own status filter defaults to "all",
 * and the page is meant to keep showing a probationer who resigned mid-window so
 * HR can close the record. An executive "decisions due" tile is a different
 * question — a person who has left needs no decision — and in production a
 * resigned Medical Representative (PD-0003, 10 days remaining) was counted here
 * until this filter existed. The tile is therefore a subset of the page it links
 * to, never a disjoint set, which is the property the old count violated.
 *
 * There is deliberately no "overdue" count any more: no surface in the product
 * lists a probationer past their 90-day window, so any such number would be
 * another dead link. Re-adding one needs an overdue view on /probation first.
 */
async function getCeoProbationCounts(access: AccessContext): Promise<{ dueSoon: number }> {
  const rows = await getProbationRows(access);

  return {
    dueSoon: rows.filter(
      (row) =>
        isActiveLifecycleStatus(row.employment_status) &&
        isProbationDecisionOutstanding(row) &&
        row.days_remaining <= lifecycleRiskWindows.probationCriticalDays,
    ).length,
  };
}

async function getCeoRecentHiresCount(): Promise<number> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const { count, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id", { count: "exact", head: true })
    .gte("hire_date", since);
  if (error) throw error;
  return count ?? 0;
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
  hiresLast30d = 0,
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
    hireExit: departuresLast30d > 0 || hiresLast30d > 0
      ? [{
          label: "Current",
          hires: hiresLast30d,
          exits: departuresLast30d,
        }]
      : [],
  };
}

// ── Fast path: main CEO data (hero + SoS + lean attention) ──────────────────

export async function getCeoCommandCenterData(access: AccessContext): Promise<CeoCommandCenterData> {
  const dataUnavailable: string[] = [];
  const platformPromise = getPlatformMetrics(access);
  // Share the in-flight platformPromise rather than chaining .then() after it —
  // getCeoAdminSignals's own 6 aggregate fetches are independent of platform
  // metrics (only needed for the health/trends fallback at the very end), so
  // gating them behind platformPromise resolving first serialized two rounds
  // of executive-signal fetching that could run concurrently.
  const adminSignalsPromise = getCeoAdminSignals(access, platformPromise);

  // Which month this card shows: the last PUBLISHED closing, not the newest upload.
  //
  // `loadSourceOfSalesDashboard(null)` picks the newest period holding a validated import batch,
  // which is right for the Source of Sales upload console — the person loading a month must see
  // the month they are loading. It is wrong for a landing page. A month's distributors arrive over
  // weeks: measured on production 2026-08-30, August held ONE validated batch worth EGP 290,387
  // while July held seventeen worth EGP 61,547,414. So from the first upload of a new month this
  // hero read 0.5% of a real month and the tables under it were nearly empty — which reads as
  // "the company sold nothing", not as "the month has barely started loading".
  //
  // The published closing is the right anchor because it is the only month the business treats as
  // true (a closing may not even be published during the month it covers — see
  // closing-period-gate.ts), and it is a fact this app already records rather than a freshness
  // heuristic that would need a threshold and would rot.
  //
  // Fired before the await below so it overlaps the platform and admin-signal fetches already in
  // flight; it is one indexed row, so it costs the page nothing. Null (nothing ever published, or
  // the lookup errored) falls through to today's exact behaviour, so this can only ever widen what
  // the card shows. `loadSourceOfSalesDashboard` itself ignores a period with no validated batch,
  // so a published month whose imports were since removed also degrades to newest-loaded.
  const closingPeriodPromise = latestPublishedClosingPeriod();
  const closingPeriod = await closingPeriodPromise;

  const [sosR, platformR, adminSignalsR, pendingPlansR] =
    await Promise.allSettled([
      loadSourceOfSalesDashboard(closingPeriod, { role: access.role }),
      platformPromise,
      adminSignalsPromise,
      getCeoPendingPlansCount(),
    ]);

  const sos = sosR.status === "fulfilled" ? sosR.value : null;
  if (!sos) dataUnavailable.push("Source of Sales (monthly)");
  const platformMetrics = platformR.status === "fulfilled" ? platformR.value : null;
  if (!platformMetrics) dataUnavailable.push("Platform company metrics");
  if (platformMetrics?.dataUnavailable.length) dataUnavailable.push(...platformMetrics.dataUnavailable);
  const adminSignals = adminSignalsR.status === "fulfilled" ? adminSignalsR.value : null;
  if (!adminSignals) dataUnavailable.push("Executive risk signals");
  if (adminSignals?.dataUnavailable.length) dataUnavailable.push(...adminSignals.dataUnavailable);
  const plansPending = pendingPlansR.status === "fulfilled" ? pendingPlansR.value : null;
  if (pendingPlansR.status === "rejected") dataUnavailable.push("Pending weekly-plan approvals");

  // Leave was moved out of "Other Approvals" onto the dedicated vacation approvals page, so
  // getAwaitingMyActionItems filters module==="leave" out of its own feed by design (see
  // action-center/service.ts). This CEO tile must source its count from the same vacation-report
  // aggregate the "leaveSla" attention signal already uses (via adminSignals), not from that
  // feed — filtering it here always returned zero, which read as "no leave waiting" even when
  // requests were pending. Null (not 0) when the underlying vacation fetch failed, so the tile
  // renders "unavailable" instead of a false all-clear.
  const leavePending = adminSignals ? adminSignals.leavePendingTotal : null;

  // The period actually rendered is whatever loadSourceOfSalesDashboard settled on, which is the
  // requested closing month only when that month really holds validated data — so read the basis
  // off the RESULT, never off what we asked for. Anything newer than the shown month and already
  // carrying data is a month in progress.
  const shownPeriod = sos?.period ?? null;
  const sosPeriodBasis: "published-closing" | "latest-upload" =
    closingPeriod !== null && shownPeriod === closingPeriod ? "published-closing" : "latest-upload";
  const sosNewerPeriods = shownPeriod
    ? [...(sos?.availablePeriods ?? [])]
        .filter((candidate) => candidate > shownPeriod)
        .sort((left, right) => right.localeCompare(left))
    : [];

  const sosOut = sos
    ? {
        period: sos.period,
        periodBasis: sosPeriodBasis,
        newerPeriods: sosNewerPeriods,
        totalValue: sos.totals.totalValue,
        totalQty: sos.totals.totalQty,
        lineCount: (sos.byLine ?? []).length,
        regionCount: (sos.byRegion ?? []).length,
        byLine: [...(sos.byLine ?? [])].map((l) => ({
          label: l.label, totalValue: l.totalValue, totalQty: l.totalQty,
        })),
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

async function getCeoAdminSignals(
  access: AccessContext,
  platformMetrics?: PlatformMetrics | Promise<PlatformMetrics>,
): Promise<CeoAdminSignals> {
  // Kick off the 6 independent aggregates and the platform-metrics resolution
  // together — platformMetrics is only consumed at the bottom of this function
  // (health/trends/payroll fallback), so it must not gate these fetches from
  // starting. Promise.all (not allSettled) here preserves the original
  // semantics: if platform metrics reject, this whole function rejects, same
  // as the prior `await getPlatformMetrics(access)` would have.
  const [signalResults, resolvedPlatformMetrics] = await Promise.all([
    Promise.allSettled([
      getResignationsDashboardData(access),
      getVacationReportData(access, { status: "all" }),
      getContractRenewalDashboardData(access),
      getCeoProbationCounts(access),
      getCoachingReports({}, access).then(buildCoachingReportAnalytics),
      getSalaryFlags(),
      getCeoRecentHiresCount(),
    ]),
    platformMetrics ?? getPlatformMetrics(access),
  ]);
  const [resignationsR, leavePendingR, contractsActiveR, probationCountsR, coachingR, flagsR, recentHiresR] = signalResults;
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
  // Total requests actually awaiting a decision (HR or manager stage), independent of the
  // SLA-prioritized `overdueLeaveSla` figure above — this is what the CEO's "Leave requests"
  // approval tile shows. Null (not 0) on fetch failure so the tile can render "unavailable"
  // rather than a false zero; the rejection is already recorded in dataUnavailable below.
  const leavePendingTotal =
    leavePendingR.status === "fulfilled" ? leavePendingR.value.dashboard.pendingByStage.total : null;
  const expiringContracts =
    contractsActiveR.status === "fulfilled"
      ? contractsActiveR.value.rows.filter((row) => {
          const delta = daysFromNow(row.contract_renewal_date);
          return delta !== null && delta >= 0 && delta <= 30;
        }).length
      : resolvedPlatformMetrics.lifecycleRisk.expiringContracts;
  const probationCounts =
    probationCountsR.status === "fulfilled" ? probationCountsR.value : { dueSoon: 0 };
  const coachingRedZone =
    coachingR.status === "fulfilled"
      ? (coachingR.value.zoneCounts.critical_red ?? 0) + (coachingR.value.zoneCounts.red_zone ?? 0)
      : 0;
  const unresolvedSalaryFlags =
    flagsR.status === "fulfilled" ? flagsR.value.unresolvedCount : resolvedPlatformMetrics.payroll.flags;
  const hiresLast30d = recentHiresR.status === "fulfilled" ? recentHiresR.value : 0;

  const signalAttention: CeoAttentionItem[] = [];
  if (expiringContracts > 0) {
    signalAttention.push({ key: "contracts", label: "Contracts expiring soon", count: expiringContracts, href: "/contracts", tone: "blue" });
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
  const trends = buildCeoTrends(resolvedPlatformMetrics, null, departuresLast30d, hiresLast30d);
  const payroll = resolvedPlatformMetrics.payroll;

  return {
    attention: signalAttention,
    dataUnavailable: Array.from(new Set(dataUnavailable)),
    departuresLast30d,
    health,
    leavePendingTotal,
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
  /** Leave/vacation requests pending a decision (HR or manager stage); null if the vacation-report fetch failed. */
  leavePendingTotal: number | null;
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
  /** CRM field activity — SFE only (see CeoLandingDeferredOptions.includeCrmField). */
  crmField: SfeCrmFieldAnalytics | null;
  /** De-cumulated week-over-week sales — SFE only (see includeWeeklyTrend). */
  weeklyTrend: CeoWeeklyTrendPoint[] | null;
  /** Per-line target vs actual — SFE only (see includeSfePerformance). */
  targets: SfeTargetPerformance | null;
  /** Sales share vs IMS market share by area — SFE only. */
  ims: SfeImsContribution | null;
  /** Doctor coverage & frequency (current Cairo month) — SFE only (see includeDoctorCoverage). */
  doctorCoverage: SfeDoctorCoverageBoard | null;
};

export type CeoWeeklyTrendPoint = {
  label: string;
  weekStart: string;
  salesValue: number;
  /** % change vs the previous week; null at the series start or across an upload gap. */
  deltaPct: number | null;
};

export type CeoLandingDeferredOptions = {
  /**
   * Outstation expense is an admin-outstation-workspace surface (canUseAdminOutstationWorkspace:
   * Super Admin to approve, CEO to read — the Finance Manager was dropped from
   * executionOnlyOutstationRoles on 2026-08-10). The SFE Manager overview does not
   * render the Expense Snapshot, so it passes `false` here and the company-wide expense read is
   * never issued for that page. Defaults to true so the CEO page is unchanged.
   */
  includeExpense?: boolean;
  /**
   * Fingerprint attendance. The SFE Manager owns sales and CRM, so his overview measures field
   * presence through CRM check-ins instead and never renders the attendance partition — passing
   * `false` skips the whole company-wide attendance aggregate for that page.
   */
  includeAttendance?: boolean;
  /** CRM field analytics (visits + check-in start times). Off by default: only the SFE page shows it. */
  includeCrmField?: boolean;
  /** Real week-over-week sales series, replacing the CEO page's click-through shortcut. */
  includeWeeklyTrend?: boolean;
  /** Per-line targets and IMS contribution. Line-scoped to SFE_VISIBLE_LINES. */
  includeSfePerformance?: boolean;
  /** Doctor coverage & frequency board (current Cairo month). Off by default: only the SFE page shows it. */
  includeDoctorCoverage?: boolean;
};

/** Days of CRM history behind the SFE field-activity partitions. */
const SFE_CRM_WINDOW_DAYS = 30;

export async function getCeoLandingDeferred(
  access: AccessContext,
  prefetchedAdminSignals?: CeoAdminSignals | null,
  options: CeoLandingDeferredOptions = {},
): Promise<CeoLandingDeferredData> {
  const {
    includeExpense = true,
    includeAttendance = true,
    includeCrmField = false,
    includeWeeklyTrend = false,
    includeSfePerformance = false,
    includeDoctorCoverage = false,
  } = options;
  const dataUnavailable: string[] = [];
  // CRM timestamps are Cairo wall-clock, so the window is seeded from the Cairo day, not the raw
  // UTC clock — after 22:00 Cairo those differ and the window would silently shift by a day.
  const crmDateTo = cairoTodayIso();
  const crmDateFrom = addDaysIso(crmDateTo, -(SFE_CRM_WINDOW_DAYS - 1));

  // Run all heavy sources concurrently. SoS is NOT re-fetched here — the fast path
  // already loads it and passes byRegion/byProduct via sosPrefetched prop on the page.
  // getCeoAdminSignals() replaces the old getAdminCommandCenterData + getOverviewDashboard
  // with CEO-safe service aggregates.
  // adminSignals is likewise reused from the fast path when it succeeded there (avoids
  // recomputing the same 6 heavy sub-fetches + getPlatformMetrics a second time per page
  // load); only re-fetched here if the fast path didn't compute it or its fetch failed.
  const [dvR, expenseR, attendanceR, marketingR, adminSignalsR, crmFieldR, weeklyR, targetsR, imsR, doctorCoverageR] = await Promise.allSettled([
    getDoubleVisitDashboardData({ access }),
    includeExpense ? getOutstationExpenseCommandData(access, { preset: "30d" }) : Promise.resolve(null),
    includeAttendance ? getAttendanceAnalytics() : Promise.resolve(null),
    getSalesMarketingDashboard(access, parseSalesMarketingDashboardFilters({})),
    prefetchedAdminSignals ? Promise.resolve(prefetchedAdminSignals) : getCeoAdminSignals(access),
    includeCrmField
      ? getSfeCrmFieldAnalytics({ dateFrom: crmDateFrom, dateTo: crmDateTo })
      : Promise.resolve(null),
    includeWeeklyTrend ? getPortalWeeklyDashboard({}, access) : Promise.resolve(null),
    includeSfePerformance ? getSfeTargetPerformance(access, SFE_VISIBLE_LINES) : Promise.resolve(null),
    includeSfePerformance ? getSfeImsContribution(SFE_VISIBLE_LINES) : Promise.resolve(null),
    // Scoped through the same resolver as the two pages rather than hardcoding "company" here, so
    // there is exactly one rule deciding whose reps a viewer may see. CEO and Super Admin resolve
    // to company; any other role reaching this dashboard resolves to no access and the rejection
    // is absorbed by the allSettled below into the normal "data unavailable" path.
    includeDoctorCoverage
      ? getDoctorCoverageScope(access).then((scope) => getSfeDoctorCoverage({ scope }))
      : Promise.resolve(null),
  ]);

  const dv = dvR.status === "fulfilled" ? dvR.value : null;
  if (!dv) dataUnavailable.push("Double-Visit Intelligence");
  const expense = expenseR.status === "fulfilled" ? expenseR.value : null;
  // Only a real failure is "unavailable" — a deliberately skipped fetch must not raise the
  // amber banner on a page that never shows the partition.
  if (!expense && includeExpense) dataUnavailable.push("Expense Snapshot");
  const attendance = attendanceR.status === "fulfilled" ? attendanceR.value : null;
  if (!attendance && includeAttendance) dataUnavailable.push("Attendance Analytics");
  const crmField = crmFieldR.status === "fulfilled" ? crmFieldR.value : null;
  if (!crmField && includeCrmField) dataUnavailable.push("CRM field activity");
  const weekly = weeklyR.status === "fulfilled" ? weeklyR.value : null;
  if (!weekly && includeWeeklyTrend) dataUnavailable.push("Weekly sales trend");
  const targets = targetsR.status === "fulfilled" ? targetsR.value : null;
  if (!targets && includeSfePerformance) dataUnavailable.push("Sales targets");
  const ims = imsR.status === "fulfilled" ? imsR.value : null;
  if (!ims && includeSfePerformance) dataUnavailable.push("IMS contribution");
  const doctorCoverage = doctorCoverageR.status === "fulfilled" ? doctorCoverageR.value : null;
  if (!doctorCoverage && includeDoctorCoverage) dataUnavailable.push("Doctor coverage");
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
          for (const [k, dates] of leaveMap) {
            if (hrIdsMatch(k, s.managerHrId) && dates.has(todayIso)) return true;
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

  // Weekly sales — `trend` is already de-cumulated (real per-week values, not running totals).
  // weekComparison carries the week-over-week delta and the spansGap suppression, so the two are
  // joined on weekStart rather than recomputing a delta here (which would silently reinstate the
  // inflated figure across an upload gap).
  const weeklyTrendOut: CeoWeeklyTrendPoint[] | null = weekly
    ? (() => {
        const deltaByWeek = new Map<string, number | null>();
        for (const row of weekly.data.weekComparison ?? []) {
          if (row.weekStart) deltaByWeek.set(row.weekStart, row.deltaValuePct);
        }
        return (weekly.data.trend ?? []).slice(-8).map((point) => ({
          label: point.weekNumber ? `W${point.weekNumber}` : point.weekStart.slice(5),
          weekStart: point.weekStart,
          salesValue: point.salesValue,
          deltaPct: deltaByWeek.get(point.weekStart) ?? null,
        }));
      })()
    : null;

  return {
    dataUnavailable: Array.from(new Set(dataUnavailable)),
    doubleVisit: dvOut,
    expense: expenseOut,
    roiSignal: roiSignalOut,
    attendance: attendanceOut,
    managersOnLeave,
    adminSignals,
    crmField,
    weeklyTrend: weeklyTrendOut,
    targets,
    ims,
    doctorCoverage,
  };
}
