import { getSalaryFlags } from "@/lib/admin/service";
import { getPlanAwaitingBadge, getVacationAwaitingBadge } from "@/lib/approvals-hub/service";
import { assertPermission, hrIdsMatch, type AccessContext } from "@/lib/auth/permissions";
import { getAttendanceAnalytics } from "@/lib/attendance/analytics";
import { loadPublishedClosingSales, type PublishedClosingSales } from "@/lib/ceo/published-closing-sales";
import { getApprovedLeaveDayMap } from "@/lib/attendance/working-days";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { getSfeCrmFieldAnalytics, type SfeCrmFieldAnalytics } from "@/lib/crm/sfe-field-analytics";
import { getSfeDoctorCoverage, type SfeDoctorCoverageBoard } from "@/lib/crm/sfe-doctor-coverage";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";
import type { DoubleVisitIdleManager, DoubleVisitManagerSummary } from "@/lib/double-visit-analytics/types";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getFinanceCommandCenterData, type FinanceCommittedMonth } from "@/lib/finance/command-center";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { adaptersFor } from "@/lib/needs-you/sources";
import { loadNeedsYouSources } from "@/lib/needs-you/service";
import {
  needsYouSourceLabels,
  type NeedsYouSourceId,
  type NeedsYouSourceResult,
} from "@/lib/needs-you/types";
import { getOutstationExpenseCommandData } from "@/lib/outstation/expense-command";
import { getPlatformMetrics, type PlatformMetrics, type UncomputedRate } from "@/lib/platform/metrics";
import { canDecideProbation } from "@/lib/probation/intelligence/decision";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { loadSourceOfSalesDashboard } from "@/lib/sales/monthly-distributor-import";
import { loadSalesReleaseKeys, newestCompanyPublishedPeriod } from "@/lib/sales/unpublished-sales-access";
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
import type { SalesMarketingRoiTrendPoint } from "@/lib/sales-marketing-intelligence/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
  /**
   * Every figure here is `null` when it was never measured — the section threw, or this viewer
   * has no permission to read it. A CEO reading 100% has no way to tell those apart from a clean
   * bill of health, which is why none of them defaults to a number any more.
   */
  health: {
    score: number | null;
    employeeHealthRate: UncomputedRate;
    employeeLinkageRate: UncomputedRate;
    salesLinkageRate: UncomputedRate;
    attendanceReadinessRate: UncomputedRate;
    salesAchievementRate: UncomputedRate;
    /** The published months `salesAchievementRate` covers, e.g. "2026-07 to 2026-10"; null when unmeasured. */
    salesAchievementWindow: string | null;
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
  /** Each counts only what waits on THIS VIEWER'S own turn (owner, 27 Nov 2026), never the company queue. */
  approvals: { leavePending: number | null; plansPending: number | null };
  /**
   * The sales card's figures: the PUBLISHED Monthly Closing (owner, 27 Nov 2026), never the raw
   * upload book in `sos`. Value only, so no unit total can be added across products. Null when no
   * month is published on every line, the read failed, or this viewer has no company-wide scope.
   */
  publishedSales: PublishedClosingSales | null;
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
    /**
     * `key` is `SourceOfSalesDashboardGroup.key` (the raw distributor sheet's group_key, e.g.
     * `"D1|Delta (1)"`), which stays unique across the array. **Still key the UI's rows on it,
     * never on `label` or `code`** — but the reason has narrowed, so do not read this note as a
     * licence to expect repeated labels.
     *
     * It used to be that duplicate labels here were routine: groups were merged on `group_key`
     * (`code|name` as captured at import) and only THEN relabelled from the master, so one code
     * that arrived under two names produced two identical-looking rows — 23 region rows for 7 real
     * regions in 2026-07. `loadSourceOfSalesDashboard` now merges on the master-resolved CODE, so
     * that class is gone and a repeated label is a finding worth chasing, not the normal case.
     * What remains is the residue the master cannot adjudicate: two groups whose codes it does not
     * know (or a null code) are deliberately left unmerged and can still collide on a label.
     */
    byRegion: Array<{ key: string; label: string; totalValue: number; totalQty: number }>;
    byProduct: Array<{ key: string; label: string; totalValue: number; totalQty: number; line: string | null }>;
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

/**
 * Clamp a rate that WAS measured. An unmeasured one stays `null` and a NaN becomes one: both mean
 * "there is no number here", and the old `: 0` turned the second into a real, terrible-looking
 * score that nobody had computed.
 */
function safeRate(value: UncomputedRate): UncomputedRate {
  if (value === null) return null;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

/**
 * The headline health score averages the rates that EXIST. Counting an unread section as 0 would
 * punish the CEO for a permission he does not have; counting it as 1 would hide a broken read.
 * With nothing measured at all there is no score, and the answer is `null`.
 */
function healthScore(health: CeoAdminSignals["health"]) {
  const values = [
    health.employeeHealthRate,
    health.salesLinkageRate,
    health.attendanceReadinessRate,
    health.salesAchievementRate,
  ]
    .map(safeRate)
    .filter((value): value is number => value !== null);
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100);
}

/**
 * Probation, contracts and coaching are no longer counted in this file at all.
 *
 * `getCeoProbationCounts` lived here and has moved into the `probation-decisions` adapter in
 * `src/lib/needs-you/sources.ts`, WITH the account of why its employment-status filter has to be
 * applied at that layer rather than inherited — it cost a production defect (PD-0003) and is the
 * kind of reason a later reader deletes if it travels without the rule. Read it there before
 * changing the window or the filters.
 */

/**
 * People who STARTED in the last 30 Cairo days. Both ends: a hire is keyed in before the start
 * date, and with only a lower bound the people starting next month counted as hired already
 * (27 Nov 2026: 31 read, 26 real).
 */
async function getCeoRecentHiresCount(): Promise<number> {
  const today = cairoTodayIso();
  const { count, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id", { count: "exact", head: true })
    .gte("hire_date", addDaysIso(today, -30))
    .lte("hire_date", today);
  if (error) throw error;
  return count ?? 0;
}

export function buildCeoHealth(
  platformMetrics: PlatformMetrics | null,
  salesLinkageRate: UncomputedRate,
  published: PublishedClosingSales | null,
): CeoAdminSignals["health"] {
  // `?? null`, never `?? 0`: no platform metrics at all means nothing was measured, and a zero
  // here reads as a real, alarming figure rather than as the absence of one.
  const workforce = platformMetrics?.workforce ?? null;
  const achievement = published?.achievement ?? null;
  return {
    attendanceReadinessRate: safeRate(platformMetrics?.attendance.mappingReadinessRate ?? null),
    employeeHealthRate: safeRate(workforce?.employeeHealthRate ?? null),
    employeeLinkageRate: safeRate(employeeManagerLinkageRate(workforce)),
    // The PUBLISHED closing's achievement, graded per line over the months that carry a target.
    // `platformMetrics.sales.achievementRate` set January-to-October sales against the months that
    // have a target and read 100% (27 Nov 2026).
    salesAchievementRate: safeRate(achievement?.rate ?? null),
    salesAchievementWindow: achievement ? ceoPeriodWindowLabel(achievement.fromPeriod, achievement.toPeriod) : null,
    salesLinkageRate: safeRate(salesLinkageRate),
  };
}

/** "2026-07 to 2026-10", or the one month when the window is a single month. */
export function ceoPeriodWindowLabel(fromPeriod: string, toPeriod: string): string {
  return fromPeriod === toPeriod ? toPeriod : `${fromPeriod} to ${toPeriod}`;
}

/**
 * Share of the employees read who are attached to a manager. The "Employee linkage" bar printed
 * `employeeHealthRate` (a headcount ratio) under this name, so it could never show a record missing
 * its manager. Null when no employee was read.
 */
export function employeeManagerLinkageRate(
  workforce: Pick<PlatformMetrics["workforce"], "employeesWithoutManagers" | "totalEmployees"> | null,
): UncomputedRate {
  if (!workforce || !workforce.totalEmployees) return null;
  const attached = Math.max(0, workforce.totalEmployees - workforce.employeesWithoutManagers);
  return attached / workforce.totalEmployees;
}

/** Resignation statuses that end in nobody leaving. */
const NON_EXIT_RESIGNATION_STATUSES: ReadonlySet<string> = new Set(["cancelled", "rejected"]);

/**
 * Departures in the last 30 days: resignations effective in [today - 30, today]. A cancelled or
 * rejected resignation is nobody leaving; counting it read 13 exits for 12 real ones (27 Nov 2026).
 */
export function ceoDeparturesLast30d(
  records: ReadonlyArray<{ effectiveDate: string | null | undefined; status?: string | null }>,
  now: Date = new Date(),
): number {
  return records.filter((record) => {
    if (NON_EXIT_RESIGNATION_STATUSES.has(String(record.status ?? "").trim().toLowerCase())) return false;
    if (!record.effectiveDate) return false;
    const time = new Date(record.effectiveDate).getTime();
    if (!Number.isFinite(time)) return false;
    const delta = Math.floor((time - now.getTime()) / 86_400_000);
    return delta <= 0 && delta >= -30;
  }).length;
}

/**
 * The three trend series, each a REAL series.
 *
 * Until 27 Nov 2026 each series held ONE point, so the sparklines always read "Not enough history
 * yet", and the point was wrong: "Monthly sales" drew the platform's year-to-date total as one
 * month, and the payroll line ignored every closed month but the newest.
 *
 *   sales     the published closing's own months (`PublishedClosingSales.monthly`).
 *   financial gross pay of each closed salary batch, the source the Finance command centre's
 *             payroll chart reads (`payroll.committed`); a month after the current Cairo month is
 *             never drawn. Revenue is that month's published sales, 0 where none is published.
 *   hireExit  the last 30 days, one labelled bar pair.
 */
export function buildCeoTrends(input: {
  published: PublishedClosingSales | null;
  payrollMonths: readonly FinanceCommittedMonth[];
  hiresLast30d: number;
  exitsLast30d: number;
  todayCairo?: string;
}): CeoCommandCenterData["trends"] {
  const currentMonth = (input.todayCairo ?? cairoTodayIso()).slice(0, 7);
  const monthly = input.published?.monthly ?? [];
  const salesByPeriod = new Map(monthly.map((month) => [month.period, month.value] as const));
  return {
    sales: monthly.map((month) => ({ label: month.period, sales: month.value, target: month.target })),
    financial: [...input.payrollMonths]
      .filter((month) => month.period <= currentMonth && Number.isFinite(month.gross) && month.gross > 0)
      .sort((left, right) => left.period.localeCompare(right.period))
      .map((month) => ({ label: month.period, revenue: salesByPeriod.get(month.period) ?? 0, cost: month.gross })),
    hireExit: input.hiresLast30d > 0 || input.exitsLast30d > 0
      ? [{ label: "Last 30 days", hires: input.hiresLast30d, exits: input.exitsLast30d }]
      : [],
  };
}

// ── Fast path: main CEO data (hero + SoS + lean attention) ──────────────────

export async function getCeoCommandCenterData(access: AccessContext): Promise<CeoCommandCenterData> {
  const dataUnavailable: string[] = [];
  const platformPromise = getPlatformMetrics(access);
  // Share the in-flight platformPromise rather than chaining .then() after it —
  // getCeoAdminSignals's own 5 aggregate fetches are independent of platform
  // metrics (only needed for the health/trends fallback at the very end), so
  // gating them behind platformPromise resolving first serialized two rounds
  // of executive-signal fetching that could run concurrently.
  // The published closing is read ONCE per page and shared: the sales card reads it here, and the
  // health and trend figures read it inside getCeoAdminSignals.
  const publishedPromise = loadPublishedClosingSales(access);
  const adminSignalsPromise = getCeoAdminSignals(access, platformPromise, publishedPromise);

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
  // flight.
  //
  // PUBLISHED ON EVERY LINE, AND IT FAILS CLOSED (owner, 2026-11-04). This card adds the three lines
  // together, so a month one line has published would carry the other two's unpublished sales. A null
  // (nothing fully published, or the lookup errored) used to fall through to the newest month loaded;
  // it now reads as unavailable. `loadSourceOfSalesDashboard` itself ignores a period with no
  // validated batch and answers its newest one instead, which is why the result is checked below.
  const closingPeriodPromise = loadSalesReleaseKeys()
    .then(newestCompanyPublishedPeriod)
    .catch(() => null);
  const closingPeriod = await closingPeriodPromise;

  const [sosR, platformR, adminSignalsR, pendingPlansR, publishedR] =
    await Promise.allSettled([
      closingPeriod ? loadSourceOfSalesDashboard(closingPeriod, { role: access.role }) : Promise.resolve(null),
      platformPromise,
      adminSignalsPromise,
      // The plans waiting on THIS VIEWER's own step (owner, 27 Nov 2026), the sidebar badge's own
      // count. It replaced a company-wide count of every plan at manager_approved plus the CEO
      // seat's Phoenix CRM queue, which put other approvers' plans on the Super Admin's tile.
      getPlanAwaitingBadge(access),
      publishedPromise,
    ]);

  const sos = sosR.status === "fulfilled" && sosR.value?.period === closingPeriod ? sosR.value : null;
  if (!sos) dataUnavailable.push("Source of Sales (monthly)");
  const platformMetrics = platformR.status === "fulfilled" ? platformR.value : null;
  if (!platformMetrics) dataUnavailable.push("Platform company metrics");
  if (platformMetrics?.dataUnavailable.length) dataUnavailable.push(...platformMetrics.dataUnavailable);
  const adminSignals = adminSignalsR.status === "fulfilled" ? adminSignalsR.value : null;
  if (!adminSignals) dataUnavailable.push("Executive risk signals");
  if (adminSignals?.dataUnavailable.length) dataUnavailable.push(...adminSignals.dataUnavailable);
  const plansBadge = pendingPlansR.status === "fulfilled" ? pendingPlansR.value : null;
  const plansPending = plansBadge?.available ? plansBadge.count : null;
  if (plansPending === null) dataUnavailable.push("Pending weekly-plan approvals");
  const publishedSales = publishedR.status === "fulfilled" ? publishedR.value : null;
  if (publishedR.status === "rejected") dataUnavailable.push("Published Monthly Closing sales");

  // The leave requests on THIS VIEWER's turn (owner, 27 Nov 2026), the sidebar badge's own count,
  // read once inside getCeoAdminSignals. Null (not 0) when that read failed, so the tile renders
  // "unavailable" instead of a false all-clear.
  const leavePending = adminSignals ? adminSignals.leavePendingTotal : null;

  // The period actually rendered is whatever loadSourceOfSalesDashboard settled on, which is the
  // requested closing month only when that month really holds validated data — so read the basis
  // off the RESULT, never off what we asked for. Nothing newer is named: a month that has landed and
  // is not published is not on this card in any form (owner, 2026-11-04).
  const shownPeriod = sos?.period ?? null;
  const sosPeriodBasis: "published-closing" | "latest-upload" =
    closingPeriod !== null && shownPeriod === closingPeriod ? "published-closing" : "latest-upload";
  const sosNewerPeriods: string[] = [];

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
          key: r.key, label: r.label, totalValue: r.totalValue, totalQty: r.totalQty,
        })),
        byProduct: [...(sos.byProduct ?? [])].sort((a, b) => b.totalValue - a.totalValue).map((p) => ({
          key: p.key, label: p.label, totalValue: p.totalValue, totalQty: p.totalQty, line: (p as { line?: string | null }).line ?? null,
        })),
      }
    : null;
  const workforce = platformMetrics?.workforce;
  const platformPayroll = platformMetrics?.payroll;
  const fallbackHealth = buildCeoHealth(platformMetrics, platformMetrics?.sales.dataQualityRate ?? null, publishedSales);
  const health = adminSignals?.health ?? fallbackHealth;
  const trends = adminSignals?.trends ?? buildCeoTrends({ published: publishedSales, payrollMonths: [], hiresLast30d: 0, exitsLast30d: 0 });

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
    publishedSales: adminSignals?.publishedSales ?? publishedSales,
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
  publishedSales?: Promise<PublishedClosingSales | null>,
): Promise<CeoAdminSignals> {
  // Kick off the 5 independent aggregates and the platform-metrics resolution
  // together — platformMetrics is only consumed at the bottom of this function
  // (health/trends/payroll fallback), so it must not gate these fetches from
  // starting. Promise.all (not allSettled) here preserves the original
  // semantics: if platform metrics reject, this whole function rejects, same
  // as the prior `await getPlatformMetrics(access)` would have.
  const [signalResults, resolvedPlatformMetrics] = await Promise.all([
    Promise.allSettled([
      getResignationsDashboardData(access),
      // The leave requests on THIS VIEWER's own turn (owner, 27 Nov 2026), the sidebar badge's own
      // count. It replaced the company's whole pending queue by stage, which put every manager's
      // and HR's waiting requests on the Super Admin's tile. Never the whole leave report either,
      // which enriches every request ever filed (11.7 s measured 2026-09-21).
      assertPermission(access, "leave", "read").then(() => getVacationAwaitingBadge(access)),
      // 🔴 CONTRACTS, PROBATION AND COACHING ARE NO LONGER COMPUTED HERE. They are three of the
      // sources `src/lib/needs-you` already owns, and until this change both files carried
      // their own copy of each rule — which had already drifted: this file's probation count filters
      // to people still employed and reads `lifecycleRiskWindows.probationCriticalDays`, where the
      // board's adapter did neither and so counted leavers. One producer per rule, from here on.
      //
      // The adapters, not `getNeedsYouBoard`: the board runs every source and this screen needs
      // three, so calling it here would add thirteen reads to the owner's heaviest landing page to
      // use none of them. `loadNeedsYouSources` runs exactly these three, with the same eight-second
      // timeout and the same three-state result.
      loadNeedsYouSources(access, adaptersFor(["contract-renewals", "probation-decisions", "coaching-red-zone"])),
      getSalaryFlags(),
      getCeoRecentHiresCount(),
      publishedSales ?? loadPublishedClosingSales(access),
      // Closed salary batches, month by month: the Finance command centre's own payroll series.
      getFinanceCommandCenterData(access).then((view) => view.data.payroll.committed),
    ]),
    platformMetrics ?? getPlatformMetrics(access),
  ]);
  const [resignationsR, leavePendingR, sharedSourcesR, flagsR, recentHiresR, publishedR, payrollMonthsR] = signalResults;
  const dataUnavailable: string[] = [];
  if (resignationsR.status === "rejected") dataUnavailable.push("Resignation risk signals");
  const leaveBadge = leavePendingR.status === "fulfilled" && leavePendingR.value.available ? leavePendingR.value : null;
  if (!leaveBadge) dataUnavailable.push("Leave SLA risk signals");
  if (flagsR.status === "rejected") dataUnavailable.push("Salary flag risk signals");
  const published = publishedR.status === "fulfilled" ? publishedR.value : null;
  if (publishedR.status === "rejected") dataUnavailable.push("Published Monthly Closing sales");
  const payrollMonths = payrollMonthsR.status === "fulfilled" ? payrollMonthsR.value : [];
  if (payrollMonthsR.status === "rejected") dataUnavailable.push("Payroll cost trend");

  /**
   * The three shared signals, read out of the board's own source results.
   *
   * 🔴 A COUNT COMES BACK ONLY FROM `ok`. `unavailable` returns null and names itself in
   * `dataUnavailable`, so the tile disappears rather than reading zero — the rule the whole module
   * turns on, now reaching this screen too. `not-applicable` is a TRUE zero (no rung on that queue)
   * and is not an alarm. If the whole load rejected, every one of the three is unknown.
   */
  const sharedSources: NeedsYouSourceResult[] = sharedSourcesR.status === "fulfilled" ? sharedSourcesR.value : [];
  const sharedCount = (id: NeedsYouSourceId, itemKey: string): number | null => {
    const result = sharedSources.find((entry) => entry.id === id);
    if (!result || result.state.status === "unavailable") {
      // Names, never codes — `needsYouSourceLabels` is a Record over the closed union, so a source
      // added without a label is a compile error rather than a row reading `probation-decisions`.
      dataUnavailable.push(`${needsYouSourceLabels[id]} risk signals`);
      return null;
    }
    if (result.state.status === "not-applicable") return 0;
    return result.state.items.find((item) => item.key === itemKey)?.count ?? 0;
  };

  const pendingResignations =
    resignationsR.status === "fulfilled" ? resignationsR.value.summary.pending : 0;
  const departuresLast30d =
    resignationsR.status === "fulfilled" ? ceoDeparturesLast30d(resignationsR.value.records) : 0;
  // OVERDUE requests on the viewer's own turn only. The old `overdueBySla.total ||
  // pendingByStage.total` fell back to the whole company queue whenever nothing was overdue, so
  // the URGENT row read "Pending leave approvals" with every waiting request in it.
  const overdueLeaveSla = leaveBadge?.overdueCount ?? 0;
  // Every request waiting on the viewer's turn: the "Leave requests" approval tile. Null (not 0)
  // on a failed read so the tile renders "unavailable" rather than a false zero.
  const leavePendingTotal = leaveBadge ? leaveBadge.count : null;
  // 🔴 THE FALLBACK TO `resolvedPlatformMetrics.lifecycleRisk.expiringContracts` IS GONE, ON
  // PURPOSE. It turned a failed contract read into a number from a different query, which is the
  // precise defect the Needs You module was built to remove: a figure a failure was allowed to
  // write. A contracts read that does not answer now removes the tile and says so in
  // `dataUnavailable`, which is the honest shape. (`payroll.unresolvedSalaryFlags` below KEEPS its
  // fallback — that field is a payroll figure this screen publishes elsewhere, not an attention
  // tile, and changing it is a separate decision.)
  const expiringContracts = sharedCount("contract-renewals", "contract-renewals:expiring");
  // Only a viewer who DECIDES probation (the CEO, a probation administrator, a National Sales
  // Manager) is shown the decisions due: to anyone else it is not a queue of his.
  const probationDueSoon = canDecideProbation(access)
    ? sharedCount("probation-decisions", "probation-decisions:due")
    : null;
  // PEOPLE, not reports — enforced in the adapter now. `zoneCounts` is a distribution over REPORTS,
  // and adding its two red buckets up under the label "Coaching red-zone reps" read 35 on production
  // against 45 reps ever coached and 18 ever red. The honest figure is 7.
  const coachingRedZone = sharedCount("coaching-red-zone", "coaching-red-zone:reps");
  const unresolvedSalaryFlags =
    flagsR.status === "fulfilled" ? flagsR.value.unresolvedCount : resolvedPlatformMetrics.payroll.flags;
  const hiresLast30d = recentHiresR.status === "fulfilled" ? recentHiresR.value : 0;

  const signalAttention: CeoAttentionItem[] = [];
  if (expiringContracts !== null && expiringContracts > 0) {
    signalAttention.push({ key: "contracts", label: "Contracts expiring soon", count: expiringContracts, href: "/contracts", tone: "blue" });
  }
  if (probationDueSoon !== null && probationDueSoon > 0) {
    signalAttention.push({
      key: "probationDue",
      label: `Probation decisions due within ${lifecycleRiskWindows.probationCriticalDays} days`,
      count: probationDueSoon,
      href: "/probation",
      tone: "amber",
    });
  }
  if (pendingResignations > 0) {
    signalAttention.push({ key: "resignations", label: "Pending resignations", count: pendingResignations, href: "/resignations", tone: "rose" });
  }
  if (overdueLeaveSla > 0) {
    signalAttention.push({ key: "leaveSla", label: "Overdue leave approvals waiting on you", count: overdueLeaveSla, href: "/admin/approvals/vacation", tone: "rose" });
  }
  if (unresolvedSalaryFlags > 0) {
    signalAttention.push({ key: "salaryFlags", label: "Unresolved salary flags", count: unresolvedSalaryFlags, href: "/admin/m-payroll", tone: "rose" });
  }
  if (coachingRedZone !== null && coachingRedZone > 0) {
    signalAttention.push({ key: "coaching", label: "Coaching red-zone reps", count: coachingRedZone, href: "/coaching", tone: "amber" });
  }

  const health = buildCeoHealth(resolvedPlatformMetrics, resolvedPlatformMetrics.sales.dataQualityRate, published);
  const trends = buildCeoTrends({ published, payrollMonths, hiresLast30d, exitsLast30d: departuresLast30d });
  const payroll = resolvedPlatformMetrics.payroll;

  return {
    attention: signalAttention,
    dataUnavailable: Array.from(new Set(dataUnavailable)),
    departuresLast30d,
    health,
    leavePendingTotal,
    publishedSales: published,
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

/**
 * The CEO's double-visit table. `managerSummaries` holds only managers who did at least one double
 * visit, so the managers doing worst — none at all — were the ones the table could never show
 * (owner, 2026-10-20). The double-visit module already lists them as `idleManagers`; each is
 * appended as a zero row, with his whole team counted neglected, and never twice.
 */
export function ceoDvManagerRows(
  managerSummaries: readonly DoubleVisitManagerSummary[],
  idleManagers: readonly DoubleVisitIdleManager[],
  leaverManagerHrIds: readonly string[] = [],
): CeoDvManagerRow[] {
  // A manager who has LEFT is not a manager to grade: his visits stay in the module's own history,
  // but a row here asked the CEO to chase someone no longer employed (owner, 27 Nov 2026).
  const isLeaver = (hrId: string) => leaverManagerHrIds.some((leaver) => hrIdsMatch(leaver, hrId));
  const rows: CeoDvManagerRow[] = managerSummaries.filter((s) => !isLeaver(s.managerHrId)).map((s) => ({
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
  }));
  for (const idle of idleManagers) {
    if (isLeaver(idle.hrId)) continue;
    if (rows.some((row) => hrIdsMatch(row.managerHrId, idle.hrId))) continue;
    const team = idle.teamMrCount ?? null;
    const hasTeam = team != null && team > 0;
    rows.push({
      managerHrId: idle.hrId,
      managerName: idle.name,
      role: idle.role,
      roleCode: idle.roleCode,
      lineName: idle.lineName ?? null,
      distinctMrs: 0,
      overFocusedMrCount: 0,
      neglectedMrCount: hasTeam ? team : null,
      neglectIndex: hasTeam ? 1 : null,
      teamMrCount: team,
      daysSinceLastDv: null,
      coveragePct: hasTeam ? 0 : null,
    });
  }
  return rows;
}

export type CeoManagerOnLeaveCandidate = { hrId: string; name: string; role: string };

/**
 * Who can be a "manager on leave": every person at least one other active employee reports to —
 * head office and field force alike. It used to be drawn from the double-visit list, which names
 * only field managers who rode along this month, so every head-office manager was invisible and
 * the card read 0 most of the month (owner, 2026-10-20). `rows` must be the ACTIVE directory
 * (`getEmployeeDirectoryRows({ includeInactive: false })`), so a manager who has left is not one.
 */
export function managerOnLeaveCandidates(
  rows: readonly Pick<EmployeeDirectoryRow, "displayName" | "fullName" | "hrId" | "jobTitle" | "managerHrId">[],
): CeoManagerOnLeaveCandidate[] {
  const managerKeys = new Set<string>();
  for (const row of rows) {
    const managerKey = normalizeHrIdForAccess(row.managerHrId);
    if (managerKey && managerKey !== normalizeHrIdForAccess(row.hrId)) managerKeys.add(managerKey);
  }
  const seen = new Set<string>();
  const candidates: CeoManagerOnLeaveCandidate[] = [];
  for (const row of rows) {
    const key = normalizeHrIdForAccess(row.hrId);
    if (!key || !managerKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      hrId: row.hrId,
      name: row.displayName || row.fullName || row.hrId,
      role: row.jobTitle?.trim() || "Manager",
    });
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

/** The candidates with an approved leave covering `todayIso` in `leaveMap`. */
export function managersOnLeaveToday(
  candidates: readonly CeoManagerOnLeaveCandidate[],
  leaveMap: ReadonlyMap<string, ReadonlySet<string>>,
  todayIso: string,
): CeoManagerOnLeaveCandidate[] {
  return candidates.filter((candidate) => {
    for (const [hrId, dates] of leaveMap) {
      if (hrIdsMatch(hrId, candidate.hrId) && dates.has(todayIso)) return true;
    }
    return false;
  });
}

export type CeoRoiSignal = {
  startedStrong: number;
  startedWeak: number;
  stillZero: number;
  /** Marketing requests in `lastPeriod`, the trend's own `requestCount`. */
  requestCount: number;
  lastPeriod: string | null;
  trend: Array<{ period: string; onTrack: number; behind: number; noData: number }>;
};

/**
 * The ROI tile's figures from the marketing trend. The trend runs to the newest month holding a
 * request, which can be a FUTURE month (a request raised for December): its last point read
 * 0 on track / 0 behind / 0 no data off one request (27 Nov 2026). The tile reads the latest month
 * that is not after the current Cairo month, and "total requests" is that month's own `requestCount`
 * rather than the sum of the three buckets, which leaves out requests not yet graded.
 */
export function ceoRoiSignalFromTrend(
  trend: readonly SalesMarketingRoiTrendPoint[],
  todayCairo: string = cairoTodayIso(),
): CeoRoiSignal {
  const currentMonth = todayCairo.slice(0, 7);
  const settled = [...trend]
    .filter((point) => String(point.period).slice(0, 7) <= currentMonth)
    .sort((left, right) => String(left.period).localeCompare(String(right.period)));
  const last = settled.length > 0 ? settled[settled.length - 1] : null;
  return {
    startedStrong: last?.onTrackCount ?? 0,
    startedWeak: last?.behindCount ?? 0,
    stillZero: last?.noDataCount ?? 0,
    requestCount: last?.requestCount ?? 0,
    lastPeriod: last?.period ?? null,
    trend: settled.slice(-6).map((point) => ({
      period: point.period,
      onTrack: point.onTrackCount,
      behind: point.behindCount,
      noData: point.noDataCount,
    })),
  };
}

export type CeoAdminSignals = {
  attention: CeoAttentionItem[];
  dataUnavailable: string[];
  /** Rolling 30-day departures (resignations effective within the last 30 days); 0 if resignation data is unavailable. */
  departuresLast30d: number;
  /** Leave requests on THIS VIEWER's own turn (the sidebar badge's count); null if that read failed. */
  leavePendingTotal: number | null;
  /** The published Monthly Closing, read once and shared with the sales card. */
  publishedSales: PublishedClosingSales | null;
  /** `null` on any rate means it was never measured — see `CeoCommandCenterData["health"]`. */
  health: {
    salesLinkageRate: UncomputedRate;
    attendanceReadinessRate: UncomputedRate;
    salesAchievementRate: UncomputedRate;
    salesAchievementWindow: string | null;
    employeeHealthRate: UncomputedRate;
    employeeLinkageRate: UncomputedRate;
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
  const [dvR, expenseR, attendanceR, marketingR, adminSignalsR, crmFieldR, weeklyR, targetsR, imsR, doctorCoverageR, activeDirectoryR] = await Promise.allSettled([
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
    // "Managers on leave today" sits inside the attendance section, so it is read only where that
    // section renders.
    includeAttendance ? getEmployeeDirectoryRows({ includeInactive: false }) : Promise.resolve(null),
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

  // Double-visit manager rows — the managers with zero double visits included (ceoDvManagerRows).
  const dvOut = dv
    ? {
        managerRows: ceoDvManagerRows(dv.managerSummaries, dv.executiveSummary.idleManagers, dv.leaverManagerHrIds ?? []),
        dateFrom: dv.dateFrom,
        dateTo: dv.dateTo,
      }
    : null;

  // Managers on leave today — every active manager in the directory (managerOnLeaveCandidates).
  let managersOnLeave: CeoLandingDeferredData["managersOnLeave"] = null;
  if (includeAttendance) {
    // "On leave TODAY" means the Cairo calendar day — the same clock `crmDateTo` above already
    // uses. Production runs UTC, so from 21:00 UTC onward this asked the leave map about
    // yesterday, and a manager on leave on the new Cairo day read as present until 03:00.
    const todayIso = cairoTodayIso();
    const activeDirectory = activeDirectoryR.status === "fulfilled" ? activeDirectoryR.value : null;
    const candidates = activeDirectory ? managerOnLeaveCandidates(activeDirectory) : null;
    try {
      if (!candidates) throw new Error("employee directory unavailable");
      // An empty list must not reach the lookup: with no HR ids it reads every leave in the company.
      managersOnLeave = candidates.length === 0
        ? []
        : managersOnLeaveToday(
            candidates,
            await getApprovedLeaveDayMap({
              dateFromIso: todayIso,
              dateToIso: todayIso,
              employeeHrIds: candidates.map((candidate) => candidate.hrId),
            }),
            todayIso,
          );
    } catch {
      // Never a quiet zero: a failed read stays null and is named in the banner.
      managersOnLeave = null;
      dataUnavailable.push("Managers on leave");
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

  // ROI signal — the latest period that is not in the future (ceoRoiSignalFromTrend).
  const roiSignalOut: CeoRoiSignal | null = marketing ? ceoRoiSignalFromTrend(marketing.roiTrend ?? []) : null;

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
