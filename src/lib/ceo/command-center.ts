import { getSalaryFlags } from "@/lib/admin/service";
import { hrIdsMatch, type AccessContext } from "@/lib/auth/permissions";
import { getAttendanceAnalytics } from "@/lib/attendance/analytics";
import { getApprovedLeaveDayMap } from "@/lib/attendance/working-days";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { getSfeCrmFieldAnalytics, type SfeCrmFieldAnalytics } from "@/lib/crm/sfe-field-analytics";
import { getSfeDoctorCoverage, type SfeDoctorCoverageBoard } from "@/lib/crm/sfe-doctor-coverage";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { adaptersFor } from "@/lib/needs-you/sources";
import { loadNeedsYouSources } from "@/lib/needs-you/service";
import {
  needsYouSourceLabels,
  type NeedsYouSourceId,
  type NeedsYouSourceResult,
} from "@/lib/needs-you/types";
import { isDistrictManagerPlanTitle } from "@/lib/weekly-planning/plan-v1";
import { planHasSecondApprover } from "@/lib/weekly-planning/second-approver";
import { ceoHrIdOf } from "@/lib/phoenix-crm/manager-plan-rules";
import { loadManagerPlanQueue } from "@/lib/phoenix-crm/server/manager-plan-queue";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { getOutstationExpenseCommandData } from "@/lib/outstation/expense-command";
import { getPlatformMetrics, type PlatformMetrics, type UncomputedRate } from "@/lib/platform/metrics";
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
import { getVacationPendingApprovalCounts } from "@/lib/vacation/service";

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
    salesLinkageRate: UncomputedRate;
    attendanceReadinessRate: UncomputedRate;
    salesAchievementRate: UncomputedRate;
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
  // Not a head-only count: a District Manager plan resting at manager_approved under a manager with
  // a second approver (second-approver.ts) is waiting on THAT approver, never on the CEO, so it
  // must not be counted here — and only the rows themselves say which plans those are.
  const [legacy, crm] = await Promise.all([
    getSupabaseAdmin().from("employee_plan_headers").select("id,manager_hr_id,employee_job_title").eq("status", "manager_approved").limit(1000),
    getCeoCrmManagerPlansWaiting(),
  ]);
  if (legacy.error) throw legacy.error;
  const legacyCount = ((legacy.data ?? []) as Array<{ manager_hr_id: string | null; employee_job_title: string | null }>).filter(
    (row) => !planHasSecondApprover(row.manager_hr_id, isDistrictManagerPlanTitle(row.employee_job_title)),
  ).length;
  return legacyCount + crm;
}

/**
 * The Phoenix CRM manager weeks, asks to edit and own-list removals waiting at the CEO's own step (owner,
 * 2026-10-17): a regional, national or product manager's week goes to the CEO "as today", where his
 * legacy plan went. Read by the CEO seat's occupant, the person stored on each row — so it counts what
 * waits on HIM whoever opens this page. A failed read throws: the tile says it could not be read.
 */
async function getCeoCrmManagerPlansWaiting(): Promise<number> {
  const ceoHrId = ceoHrIdOf(await loadPhoenixCrmOrg());
  if (!ceoHrId) return 0;
  return (await loadManagerPlanQueue(ceoHrId, false)).awaiting.length;
}

function buildCeoHealth(
  platformMetrics: PlatformMetrics | null,
  salesLinkageRate: UncomputedRate,
): CeoAdminSignals["health"] {
  // `?? null`, never `?? 0`: no platform metrics at all means nothing was measured, and a zero
  // here reads as a real, alarming figure rather than as the absence of one.
  return {
    attendanceReadinessRate: safeRate(platformMetrics?.attendance.mappingReadinessRate ?? null),
    employeeHealthRate: safeRate(platformMetrics?.workforce.employeeHealthRate ?? null),
    salesAchievementRate: safeRate(platformMetrics?.sales.achievementRate ?? null),
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
  // getCeoAdminSignals's own 5 aggregate fetches are independent of platform
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
          key: r.key, label: r.label, totalValue: r.totalValue, totalQty: r.totalQty,
        })),
        byProduct: [...(sos.byProduct ?? [])].sort((a, b) => b.totalValue - a.totalValue).map((p) => ({
          key: p.key, label: p.label, totalValue: p.totalValue, totalQty: p.totalQty, line: (p as { line?: string | null }).line ?? null,
        })),
      }
    : null;
  const workforce = platformMetrics?.workforce;
  const platformPayroll = platformMetrics?.payroll;
  const fallbackHealth = buildCeoHealth(platformMetrics, platformMetrics?.sales.dataQualityRate ?? null);
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
  // Kick off the 5 independent aggregates and the platform-metrics resolution
  // together — platformMetrics is only consumed at the bottom of this function
  // (health/trends/payroll fallback), so it must not gate these fetches from
  // starting. Promise.all (not allSettled) here preserves the original
  // semantics: if platform metrics reject, this whole function rejects, same
  // as the prior `await getPlatformMetrics(access)` would have.
  const [signalResults, resolvedPlatformMetrics] = await Promise.all([
    Promise.allSettled([
      getResignationsDashboardData(access),
      // The two approval counts only — never the whole leave report, which enriches every request
      // ever filed and was the slowest read behind /admin (11.7 s measured 2026-09-21).
      getVacationPendingApprovalCounts(access),
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
    ]),
    platformMetrics ?? getPlatformMetrics(access),
  ]);
  const [resignationsR, leavePendingR, sharedSourcesR, flagsR, recentHiresR] = signalResults;
  const dataUnavailable: string[] = [];
  if (resignationsR.status === "rejected") dataUnavailable.push("Resignation risk signals");
  if (leavePendingR.status === "rejected") dataUnavailable.push("Leave SLA risk signals");
  if (flagsR.status === "rejected") dataUnavailable.push("Salary flag risk signals");

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
      ? leavePendingR.value.overdueBySla.total || leavePendingR.value.pendingByStage.total
      : 0;
  // Total requests actually awaiting a decision (HR or manager stage), independent of the
  // SLA-prioritized `overdueLeaveSla` figure above — this is what the CEO's "Leave requests"
  // approval tile shows. Null (not 0) on fetch failure so the tile can render "unavailable"
  // rather than a false zero; the rejection is already recorded in dataUnavailable below.
  const leavePendingTotal =
    leavePendingR.status === "fulfilled" ? leavePendingR.value.pendingByStage.total : null;
  // 🔴 THE FALLBACK TO `resolvedPlatformMetrics.lifecycleRisk.expiringContracts` IS GONE, ON
  // PURPOSE. It turned a failed contract read into a number from a different query, which is the
  // precise defect the Needs You module was built to remove: a figure a failure was allowed to
  // write. A contracts read that does not answer now removes the tile and says so in
  // `dataUnavailable`, which is the honest shape. (`payroll.unresolvedSalaryFlags` below KEEPS its
  // fallback — that field is a payroll figure this screen publishes elsewhere, not an attention
  // tile, and changing it is a separate decision.)
  const expiringContracts = sharedCount("contract-renewals", "contract-renewals:expiring");
  const probationDueSoon = sharedCount("probation-decisions", "probation-decisions:due");
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
      label: `Probation decisions due (${lifecycleRiskWindows.probationCriticalDays}d)`,
      count: probationDueSoon,
      href: "/probation",
      tone: "amber",
    });
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
  if (coachingRedZone !== null && coachingRedZone > 0) {
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
  /** `null` on any rate means it was never measured — see `CeoCommandCenterData["health"]`. */
  health: {
    salesLinkageRate: UncomputedRate;
    attendanceReadinessRate: UncomputedRate;
    salesAchievementRate: UncomputedRate;
    employeeHealthRate: UncomputedRate;
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
    // "On leave TODAY" means the Cairo calendar day — the same clock `crmDateTo` above already
    // uses. Production runs UTC, so from 21:00 UTC onward this asked the leave map about
    // yesterday, and a manager on leave on the new Cairo day read as present until 03:00.
    const todayIso = cairoTodayIso();
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
