import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { queryVisitsLimited } from "@/lib/crm/reads";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { devSafePromiseAllSettled } from "@/lib/utils/dev-safe-promise-all";
import { getVacationBalancePeriod } from "@/lib/vacation/calculations";
import {
  getDsmTeamPerformance,
  getEmployeePortalShellData,
  getNsmDsmPerformance,
  getRmRegionalPerformance,
  type EmployeePortalShellData,
} from "@/lib/employee-portal/service";
import {
  getEmployeeDirectoryRows,
  isActiveDirectoryEmployee,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { approvedMarketingRequestStatuses, getMarketingOverview, type MarketingOverviewMetrics } from "@/lib/marketing-requests/service";
import { getAwaitingMyActionItems } from "@/lib/action-center/service";
import { countPlanAwaiting } from "@/lib/approvals-hub/service";
import { getDoubleVisitPortalFocus } from "@/lib/double-visit-analytics/service";
import type { DoubleVisitPortalFocus } from "@/lib/double-visit-analytics/types";
import { getNsmCrmCompliance, nsmCrmComplianceUnavailable, type NsmCrmComplianceData } from "@/lib/employee-portal/nsm-crm-compliance";
import { getLatestLineEarlyBirds, type EarlyBirdsWinnerRecord } from "@/lib/early-birds/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { currentCairoDateParts } from "@/lib/i18n/format";
import {
  SALES_HISTORY_FLOOR,
  loadEmployeeMonthlyAchievement,
  uploadedPointsOnly,
  type MonthlyAchievementPoint,
} from "@/lib/sales/employee-achievement";

/**
 * The MR landing figures, from SoS Monthly Closing — the same engine as Monthly Closing and
 * /sales-vs-target, so the number a rep sees on their home page equals the number their DM,
 * the closing view and the incentive tab see for the same month (Rule #1).
 *
 * Both figures use UPLOADED months only. On 2026-08-10 August held a single 1,309.50 EGP
 * direct order against a 17,508,935 EGP target; keyed on "does this month have any actual",
 * the hero would have greeted that rep with 0.0%. An un-uploaded current month returns null,
 * which the widget already renders as "Data not yet available" — the same thing the legacy
 * query produced when sales_records had no rows yet.
 */
async function loadMrCanonicalSales(hrId: string): Promise<{
  current: { achievementPercent: number; salesValue: number; targetValue: number } | null;
  trend: Array<{ year: number; month: number; achievementPercent: number; salesValue: number; targetValue: number }> | null;
}> {
  const { year, month } = currentCairoDateParts();
  const currentPeriod = `${year}-${String(month).padStart(2, "0")}`;
  const window = await loadEmployeeMonthlyAchievement([hrId], SALES_HISTORY_FLOOR, currentPeriod);
  const points = uploadedPointsOnly(window.byHrId.get(hrId) ?? []);
  if (points.length === 0) return { current: null, trend: null };

  const percentOf = (point: MonthlyAchievementPoint) =>
    point.achievementValue != null ? point.achievementValue * 100 : 0;

  const currentPoint = points.find((point) => point.period === currentPeriod) ?? null;
  return {
    current: currentPoint
      ? {
          achievementPercent: percentOf(currentPoint),
          salesValue: currentPoint.actualValue,
          targetValue: currentPoint.targetValue,
        }
      : null,
    // Newest first, and never capped by a row limit — the engine returns one row per month,
    // so a high-volume rep cannot lose a month to pagination the way the old 200-row cap allowed.
    trend: points
      .slice()
      .sort((left, right) => right.period.localeCompare(left.period))
      .slice(0, 4)
      .map((point) => {
        const [yearPart, monthPart] = point.period.split("-");
        return {
          year: Number(yearPart),
          month: Number(monthPart),
          achievementPercent: Math.round(percentOf(point)),
          salesValue: point.actualValue,
          targetValue: point.targetValue,
        };
      }),
  };
}

// Roles that get the double-visit "focus" landing widgets (trend, scope coverage, probation
// watch) and the Double Visit Report page. Kept as its own gate (rather than folded into
// getRoleSpecificExtras) since it applies uniformly across all six roles instead of following
// the one-branch-per-role KPI pattern below. Exported so the report page's access check and the
// snapshot builder share one definition instead of drifting.
export const DV_FOCUS_ROLES = new Set([
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
]);

/**
 * Resigned people are OFF the daily CRM board — not greyed out, not listed red as "did not
 * submit". Absent.
 *
 * The rosters handed to getNsmCrmCompliance come from the sales-performance services
 * (getDsmTeamPerformance / national / regional), which are membership-by-sales-history and
 * legitimately keep a leaver who booked sales in the period. A compliance board is a different
 * question — "who started work today" — and a leaver can only ever answer it in red. B-97 Nada
 * Elsharkawy sat on her manager's red list for six weeks after resigning on 2026-06-28.
 *
 * Guarded on a NON-EMPTY directory on purpose: getEmployeeDirectoryRows is called with
 * `.catch(() => [])` at every one of these call sites, and filtering against an empty active-set
 * would erase the whole roster — which this board renders as "nobody on your team submitted
 * today", a confident lie. A failed directory read must degrade to unfiltered, never to empty.
 */
export function activeRosterOnly<T extends { hrId: string }>(
  roster: readonly T[],
  directoryRows: readonly EmployeeDirectoryRow[],
): T[] {
  const key = (value?: string | null) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const activeKeys = new Set(
    directoryRows.filter(isActiveDirectoryEmployee).map((row) => key(row.hrId)).filter(Boolean),
  );
  if (activeKeys.size === 0) return [...roster];
  return roster.filter((row) => activeKeys.has(key(row.hrId)));
}

export type UpcomingMarketingActivity = { id: string; requestCode: string; payDate: string; estimatedCost: number };

export type PortalHomeSnapshot = {
  shell: EmployeePortalShellData;
  role: string;
  /** This fortnight's stars, one per line, shown as a compact card on every audience's landing
   * page. Empty until the first fortnight is confirmed — the card renders nothing rather than an
   * empty box. */
  earlyBirdStars: EarlyBirdsWinnerRecord[];
  pendingVacationCount: number;
  pendingExcuseCount: number;
  /**
   * False when either pending-count query failed/timed out. Counts stay 0 for arithmetic, but the
   * UI must show a "couldn't load" state instead of a misleading "All clear" green banner (honest
   * empty state — a failed source must never read as "nothing needs your attention").
   */
  pendingCountsAvailable: boolean;
  latestPayslip: { month: string; netSalary: number } | null;
  leaveEntitlementDays: number | null;
  mrSalesAchievement: { achievementPercent: number; salesValue: number; targetValue: number } | null;
  monthlySalesTrend: Array<{ year: number; month: number; achievementPercent: number; salesValue: number; targetValue: number }> | null;
  doubleVisitPulse: { daysSinceLastDv: number | null; dvsThisMonth: number; dvsLast90Days: number } | null;
  mrPendingExpenseCount: number | null;
  /** Product / Group Product Manager only: the PM's own marketing requests still in flight + upcoming pay dates. */
  pmMarketing: { myPendingRequests: number; upcoming: UpcomingMarketingActivity[] } | null;
  /**
   * Marketing Manager only: company-wide approval/validation pipeline counts + upcoming pay dates
   * (company-wide). `asOf` is a server-stamped epoch (ms) so the dashboard can compute inbox aging
   * without calling Date.now() during render (which is impure for a React component).
   */
  mmOverview: (MarketingOverviewMetrics & { upcoming: UpcomingMarketingActivity[]; asOf: number }) | null;
  /** District Manager only: the DSM's own med-rep team, current period, + team approvals awaiting
   * the DSM, + the CRM first-visit board for that team. `members` is the top-10 sales leaderboard;
   * `crm` covers every direct report, ranked and uncapped. */
  dsmTeam:
    | {
        achievementPercent: number;
        memberCount: number;
        totalSales: number;
        totalTarget: number;
        pendingApprovals: number;
        members: Array<{ hrId: string; name: string; achievementPercent: number; totalSales: number; totalTarget: number }>;
        crm: NsmCrmComplianceData;
      }
    | null;
  /** National Sales Manager only: the NSM's line, rolled up by DSM, + approvals awaiting the NSM. */
  nsmNational:
    | { achievementPercent: number; dsmCount: number; totalSales: number; totalTarget: number; pendingApprovals: number }
    | null;
  /**
   * National Sales Manager only: leaderboards (DSMs + top med reps by achievement %) and the
   * CRM first-visit compliance board for the NSM's line. Null for every other role / on failure.
   */
  nsmBoard:
    | {
        dsms: Array<{ hrId: string; name: string; achievementPercent: number; totalSales: number; totalTarget: number }>;
        topReps: Array<{
          hrId: string;
          name: string;
          achievementPercent: number;
          totalSales: number;
          totalTarget: number;
          managerName: string | null;
        }>;
        crm: NsmCrmComplianceData | null;
      }
    | null;
  /**
   * Regional Manager only: the RM's region rolled up by district (DSM), plus the DSM leaderboard,
   * the region's top med reps, and the region's CRM first-visit compliance board.
   *
   * Region membership is the RM's own product line NARROWED to the regions found within their
   * management subtree (`regionsWithinManagerHierarchy`), never their own coarse `region_name`
   * label — see getRmRegionalPerformance in employee-portal/service.ts for the owner rule.
   */
  rmRegional:
    | {
        achievementPercent: number;
        dsmCount: number;
        totalSales: number;
        totalTarget: number;
        /** Region sales carried by no district row (vacant-DM reps + in-region direct orders). */
        unattributedSales: number;
        pendingApprovals: number;
        /** Districts (DSMs) inside the RM's region set, ranked by achievement % then sales. */
        dsms: Array<{ hrId: string; name: string; achievementPercent: number; totalSales: number; totalTarget: number }>;
        /** Top med reps inside the RM's region set, ranked the same way. */
        topReps: Array<{
          hrId: string;
          name: string;
          achievementPercent: number;
          totalSales: number;
          totalTarget: number;
          managerName: string | null;
        }>;
        crm: NsmCrmComplianceData | null;
      }
    | null;
  plansAwaitingManagerApproval: number | null;
  /** DM/RM/NSM/PM/GPM/TM only: personal DV trend, scope coverage, and probation DV watchlist. */
  dvFocus: DoubleVisitPortalFocus | null;
};

type RoleSpecificExtras = Pick<
  PortalHomeSnapshot,
  "pmMarketing" | "mmOverview" | "dsmTeam" | "nsmNational" | "nsmBoard" | "rmRegional"
>;

const emptyRoleExtras: RoleSpecificExtras = {
  pmMarketing: null,
  mmOverview: null,
  dsmTeam: null,
  nsmNational: null,
  nsmBoard: null,
  rmRegional: null,
};

/** Cheap, single-query "what's paying out soon" — real pay_date rows, no recomputation. */
async function getUpcomingMarketingActivity(requesterHrId?: string): Promise<UpcomingMarketingActivity[]> {
  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  let query = supabase
    .from("marketing_requests")
    .select("id, request_code, pay_date, estimated_cost")
    .in("status", approvedMarketingRequestStatuses)
    .gte("pay_date", today)
    .order("pay_date", { ascending: true })
    .limit(5);
  if (requesterHrId) {
    query = query.eq("requester_hr_id", requesterHrId.toUpperCase());
  }
  const { data, error } = await query;
  if (error || !data) return [];
  return data
    .filter((row): row is { id: string; request_code: string; pay_date: string; estimated_cost: number } => Boolean(row.pay_date))
    .map((row) => ({
      id: row.id,
      requestCode: row.request_code,
      payDate: row.pay_date,
      estimatedCost: Number(row.estimated_cost ?? 0),
    }));
}

/** One lightweight, role-gated query/aggregate — never throws, never blocks the rest of the snapshot. */
async function getRoleSpecificExtras(access: AccessContext, role: string, hrId: string): Promise<RoleSpecificExtras> {
  try {
    if (role === "Product Manager" || role === "Group Product Manager") {
      if (!hrId) return emptyRoleExtras;
      const supabase = getSupabaseAdmin();
      const [{ count }, upcoming] = await Promise.all([
        supabase
          .from("marketing_requests")
          .select("id", { count: "exact", head: true })
          .eq("requester_hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
          .in("status", ["draft", "pending_approval", "returned"]),
        getUpcomingMarketingActivity(hrId),
      ]);
      return { ...emptyRoleExtras, pmMarketing: { myPendingRequests: count ?? 0, upcoming } };
    }
    if (role === "Marketing Manager") {
      const [overview, upcoming] = await Promise.all([getMarketingOverview(access), getUpcomingMarketingActivity()]);
      return { ...emptyRoleExtras, mmOverview: { ...overview, upcoming, asOf: Date.now() } };
    }
    if (role === "District Manager") {
      const [team, approvals, directoryRows] = await Promise.all([
        getDsmTeamPerformance(access, {}),
        getAwaitingMyActionItems(access, "portal").catch(() => []),
        getEmployeeDirectoryRows().catch(() => []),
      ]);
      if (!team) return emptyRoleExtras;

      // Show the nickname when set, else the full name. The performance services return
      // raw full names, so resolve the directory's nickname-aware displayName by a
      // hyphen-insensitive HR-ID key (canonical "B100" and stored "B-100" both match).
      const nameKey = (value?: string | null) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const displayByKey = new Map<string, string>();
      for (const row of directoryRows) {
        const key = nameKey(row.hrId);
        if (key) displayByKey.set(key, row.displayName);
      }
      const display = (hrId: string | null | undefined, fallback: string) =>
        displayByKey.get(nameKey(hrId)) ?? fallback;

      const members = (team.members ?? [])
        .slice()
        .sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales)
        .slice(0, 10)
        .map((m) => ({
          hrId: m.hrId,
          name: display(m.hrId, m.name),
          achievementPercent: m.achievementPercent,
          totalSales: m.totalSales,
          totalTarget: m.totalTarget,
        }));

      // CRM first-visit compliance over the DM's FULL direct-report roster — deliberately
      // `team.members`, not the `members` leaderboard above, which is sliced to the top 10 by
      // achievement. Ranking a compliance board off a sales leaderboard would silently hide every
      // rep outside the top 10 from both the green and the red list. `dsms: []` because a District
      // Manager anchors med reps only (getDsmTeamPerformance runs in "dsm-direct" mode), and the
      // board is uncapped so nobody on a team this size drops off the ranking.
      const crmInput = {
        reps: activeRosterOnly(
          (team.members ?? []).map((m) => ({ hrId: m.hrId, name: display(m.hrId, m.name) })),
          directoryRows,
        ),
        dsms: [],
        limit: Number.POSITIVE_INFINITY,
      };
      const crm = await getNsmCrmCompliance(crmInput).catch((error: unknown) => {
        logPortalFailure(
          { hrId: access.hrId, module: "dsm-crm-compliance", role: access.role, route: "/employee-portals" },
          error,
        );
        return nsmCrmComplianceUnavailable(crmInput);
      });

      return {
        ...emptyRoleExtras,
        dsmTeam: {
          achievementPercent: team.teamAchievementPercent,
          memberCount: team.teamMemberCount,
          totalSales: team.teamTotalSales,
          totalTarget: team.teamTotalTarget,
          pendingApprovals: approvals.length,
          members,
          crm,
        },
      };
    }
    if (role === "National Sales Manager") {
      const [national, repTeam, approvals, directoryRows] = await Promise.all([
        getNsmDsmPerformance(access, {}),
        getDsmTeamPerformance(access, {}),
        getAwaitingMyActionItems(access, "portal").catch(() => []),
        getEmployeeDirectoryRows().catch(() => []),
      ]);
      if (!national) return emptyRoleExtras;

      // Show the nickname when set, else the full name. The performance services return
      // raw full names, so resolve the directory's nickname-aware displayName by a
      // hyphen-insensitive HR-ID key (canonical "B100" and stored "B-100" both match).
      const nameKey = (value?: string | null) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const displayByKey = new Map<string, string>();
      for (const row of directoryRows) {
        const key = nameKey(row.hrId);
        if (key) displayByKey.set(key, row.displayName);
      }
      const display = (hrId: string | null | undefined, fallback: string) =>
        displayByKey.get(nameKey(hrId)) ?? fallback;

      const dsms = national.dsms.map((d) => ({
        hrId: d.hrId,
        name: display(d.hrId, d.name),
        achievementPercent: d.achievementPercent,
        totalSales: d.totalSales,
        totalTarget: d.totalTarget,
      }));

      const repMembers = repTeam?.members ?? [];
      const topReps = repMembers
        .slice()
        .sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales)
        .slice(0, 10)
        .map((m) => ({
          hrId: m.hrId,
          name: display(m.hrId, m.name),
          achievementPercent: m.achievementPercent,
          totalSales: m.totalSales,
          totalTarget: m.totalTarget,
          managerName: m.managerName ? display(m.managerHrId, m.managerName) : m.managerName,
        }));

      // CRM first-visit compliance over the full line roster (all reps + DSMs), not just the top 10.
      const crmInput = {
        reps: activeRosterOnly(
          repMembers.map((m) => ({ hrId: m.hrId, name: display(m.hrId, m.name) })),
          directoryRows,
        ),
        dsms: activeRosterOnly(
          dsms.map((d) => ({ hrId: d.hrId, name: d.name })),
          directoryRows,
        ),
      };
      const crm = await getNsmCrmCompliance(crmInput).catch((error: unknown) => {
        logPortalFailure(
          { hrId: access.hrId, module: "nsm-crm-compliance", role: access.role, route: "/employee-portals" },
          error,
        );
        return nsmCrmComplianceUnavailable(crmInput);
      });

      return {
        ...emptyRoleExtras,
        nsmNational: {
          achievementPercent: national.lineAchievementPercent,
          dsmCount: national.dsmCount,
          totalSales: national.lineTotalSales,
          totalTarget: national.lineTotalTarget,
          pendingApprovals: approvals.length,
        },
        nsmBoard: { dsms, topReps, crm },
      };
    }
    if (role === "Regional Manager") {
      const [regional, approvals, directoryRows] = await Promise.all([
        getRmRegionalPerformance(access, {}),
        getAwaitingMyActionItems(access, "portal").catch(() => []),
        getEmployeeDirectoryRows().catch(() => []),
      ]);
      if (!regional) return emptyRoleExtras;

      // Same nickname resolution as the DSM/NSM branches above: the performance services return
      // raw full names, so resolve the directory's nickname-aware displayName by a
      // hyphen-insensitive HR-ID key (canonical "B100" and stored "B-100" both match).
      const nameKey = (value?: string | null) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const displayByKey = new Map<string, string>();
      for (const row of directoryRows) {
        const key = nameKey(row.hrId);
        if (key) displayByKey.set(key, row.displayName);
      }
      const display = (hrId: string | null | undefined, fallback: string) =>
        displayByKey.get(nameKey(hrId)) ?? fallback;

      const dsms = regional.dsms.map((d) => ({
        hrId: d.hrId,
        name: display(d.hrId, d.name),
        achievementPercent: d.achievementPercent,
        totalSales: d.totalSales,
        totalTarget: d.totalTarget,
      }));

      const topReps = regional.topReps.slice(0, 10).map((m) => ({
        hrId: m.hrId,
        name: display(m.hrId, m.name),
        achievementPercent: m.achievementPercent,
        totalSales: m.totalSales,
        totalTarget: m.totalTarget,
        managerName: m.managerName ? display(m.managerHrId, m.managerName) : m.managerName,
      }));

      // CRM first-visit compliance over the RM's FULL region roster (every rep + DSM in scope),
      // not just the top 10 shown in the leaderboard. getNsmCrmCompliance is roster-driven, so
      // passing the region-scoped roster reuses it as-is without widening access.
      const crmInput = {
        reps: activeRosterOnly(
          regional.topReps.map((m) => ({ hrId: m.hrId, name: display(m.hrId, m.name) })),
          directoryRows,
        ),
        dsms: activeRosterOnly(
          dsms.map((d) => ({ hrId: d.hrId, name: d.name })),
          directoryRows,
        ),
      };
      const crm = await getNsmCrmCompliance(crmInput).catch((error: unknown) => {
        logPortalFailure(
          { hrId: access.hrId, module: "rm-crm-compliance", role: access.role, route: "/employee-portals" },
          error,
        );
        return nsmCrmComplianceUnavailable(crmInput);
      });

      return {
        ...emptyRoleExtras,
        rmRegional: {
          achievementPercent: regional.regionAchievementPercent,
          dsmCount: regional.dsmCount,
          totalSales: regional.regionTotalSales,
          totalTarget: regional.regionTotalTarget,
          unattributedSales: regional.unattributedSales,
          pendingApprovals: approvals.length,
          dsms,
          topReps,
          crm,
        },
      };
    }
  } catch {
    // Non-fatal — the role-specific widget falls back to its own empty state.
  }
  return emptyRoleExtras;
}

// Stats-only snapshot for the MR streaming path (called after the fast shell render)
export type MrHomeStats = {
  pendingVacationCount: number;
  pendingExcuseCount: number;
  pendingCountsAvailable: boolean;
  latestPayslip: { month: string; netSalary: number } | null;
  leaveEntitlementDays: number | null;
  mrSalesAchievement: { achievementPercent: number; salesValue: number; targetValue: number } | null;
};

export async function getMrHomeStats(
  access: AccessContext,
  shell: EmployeePortalShellData,
): Promise<MrHomeStats> {
  const hrId = normalizeHrId(access.hrId) ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();

  const mrSalesPromise = hrId
    ? loadMrCanonicalSales(hrId).catch(() => null)
    : Promise.resolve(null);

  const [vacationResult, excuseResult, batchResult] = await Promise.allSettled([
    supabase
      .from("v2_vacation_requests")
      .select("id", { count: "exact", head: true })
      .eq("employee_hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
      .in("status", ["pending_manager", "pending_hr"]),
    supabase
      .from("v2_excuse_requests")
      .select("id", { count: "exact", head: true })
      .eq("employee_hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
      .eq("status", "pending_manager"),
    supabase
      .from("salary_batches")
      .select("id, year, month")
      .in("status", ["approved", "locked"])
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const pendingVacationCount =
    vacationResult.status === "fulfilled" ? (vacationResult.value.count ?? 0) : 0;
  const pendingExcuseCount =
    excuseResult.status === "fulfilled" ? (excuseResult.value.count ?? 0) : 0;
  const pendingCountsAvailable =
    vacationResult.status === "fulfilled" && excuseResult.status === "fulfilled";

  let latestPayslip: MrHomeStats["latestPayslip"] = null;
  if (batchResult.status === "fulfilled" && batchResult.value.data && hrId) {
    const batch = batchResult.value.data;
    const { data: record } = await supabase
      .from("salary_records")
      .select("net_salary")
      .eq("batch_id", batch.id)
      .eq("hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
      .maybeSingle();
    if (record?.net_salary) {
      latestPayslip = {
        month: `${batch.year}-${String(batch.month).padStart(2, "0")}`,
        netSalary: Number(record.net_salary),
      };
    }
  }

  let mrSalesAchievement: MrHomeStats["mrSalesAchievement"] = null;
  try {
    mrSalesAchievement = (await mrSalesPromise)?.current ?? null;
  } catch {
    // null on failure
  }

  const balance = getVacationBalancePeriod({ hireDate: shell.hrContract.hireDate, referenceDate: today });

  return {
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    latestPayslip,
    leaveEntitlementDays: balance?.entitlementDays ?? null,
    mrSalesAchievement,
  };
}

const wrapPromise = <T,>(thenable: PromiseLike<T>): Promise<T> =>
  new Promise((resolve, reject) => thenable.then(resolve, reject));

export async function getPortalHomeSnapshot(access: AccessContext): Promise<PortalHomeSnapshot> {
  const shell = await getEmployeePortalShellData(access);
  const hrId = normalizeHrId(access.hrId) ?? "";
  const role = access.role ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const isMr = role.toLowerCase() === "medical rep";

  // Start MR sales query + the role-specific KPI extras immediately so they run in parallel
  // with the batch below. getRoleSpecificExtras never throws — it resolves emptyRoleExtras
  // for roles it doesn't recognize and on any internal failure.
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // One canonical load serves BOTH the hero and the 4-month trend — they are the same window.
  const mrSalesPromise = isMr && hrId ? loadMrCanonicalSales(hrId) : Promise.resolve(null);
  const roleExtrasPromise = getRoleSpecificExtras(access, role, hrId);
  const dvFocusPromise: Promise<DoubleVisitPortalFocus | null> = DV_FOCUS_ROLES.has(role)
    ? getDoubleVisitPortalFocus(access).catch(() => null)
    : Promise.resolve(null);

  // Double-visit rows for this MR — most recent first so [0] is the latest visit. Reads via the
  // CRM read layer (the shared double_crm_id + visit_type predicate): Regular/Campaign visits
  // with a double-visit partner.
  const dvPromise =
    isMr && hrId
      ? wrapPromise(
          queryVisitsLimited<{ visit_date: string }>({
            // The CRM read door matches hr ids case-insensitively — pass the raw id, no UPPER guess.
            agentHrIds: [hrId],
            doubleOnly: true,
            visitTypes: [0, -8],
            columns: "visit_date",
            orderBy: "visit_date",
            ascending: false,
            limit: 500,
            // Collapse burst-duplicate re-saves so the "DVs this month / last 90 days" pulse matches
            // the collapsed numbers on the Double Visit Analytics page for the same rep.
            collapseDoubleVisits: true,
          }),
        )
      : Promise.resolve(null);

  // Submitted (pending reimbursement) expense count — lightweight head-only query.
  const expensePromise =
    isMr && hrId
      ? wrapPromise(
          supabase
            .from("outstation_expense_requests")
            .select("id", { count: "exact", head: true })
            .eq("employee_hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
            .eq("status", "submitted"),
        )
      : Promise.resolve(null);

  // Plans waiting for this user's manager approval (non-MR portal managers only).
  //
  // Reads the canonical approvals-hub responder logic, NOT a raw table count. This used to query
  // `weekly_plans` directly, which is the SUPERSEDED plan generation — the live plan engine is
  // `employee_plan_headers`/`_items`/`_decisions`, and `weekly_plans` holds ZERO rows in
  // production. Every portal manager therefore saw "0 plans awaiting approval" on their home page
  // no matter how many were actually queued. Found by the 2026-08-13 rationalization audit.
  //
  // countPlanAwaiting() is the same function behind the sidebar badge
  // (/api/approvals/plan/pending-count), so the home card and the badge can no longer disagree —
  // it resolves the responder chain (manager vs CEO step) rather than matching one column.
  const managerPlanCountPromise =
    !isMr && hrId
      ? wrapPromise(countPlanAwaiting(access).then((count) => ({ count })))
      : Promise.resolve(null);

  // All three fire in parallel (sequential in dev to protect Turbopack workers).
  const [vacationResult, excuseResult, batchResult] = await devSafePromiseAllSettled([
    () =>
      wrapPromise(
        supabase
          .from("v2_vacation_requests")
          .select("id", { count: "exact", head: true })
          .eq("employee_hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
          .in("status", ["pending_manager", "pending_hr"]),
      ),
    () =>
      wrapPromise(
        supabase
          .from("v2_excuse_requests")
          .select("id", { count: "exact", head: true })
          .eq("employee_hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
          .eq("status", "pending_manager"),
      ),
    () =>
      wrapPromise(
        supabase
          .from("salary_batches")
          .select("id, year, month")
          .in("status", ["approved", "locked"])
          .order("year", { ascending: false })
          .order("month", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
  ]);

  const pendingVacationCount =
    vacationResult.status === "fulfilled" ? (vacationResult.value.count ?? 0) : 0;
  const pendingExcuseCount =
    excuseResult.status === "fulfilled" ? (excuseResult.value.count ?? 0) : 0;
  const pendingCountsAvailable =
    vacationResult.status === "fulfilled" && excuseResult.status === "fulfilled";

  // One fast lookup: employee's record in the latest batch.
  let latestPayslip: PortalHomeSnapshot["latestPayslip"] = null;
  if (batchResult.status === "fulfilled" && batchResult.value.data && hrId) {
    const batch = batchResult.value.data;
    const { data: record } = await supabase
      .from("salary_records")
      .select("net_salary")
      .eq("batch_id", batch.id)
      .eq("hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
      .maybeSingle();
    if (record?.net_salary) {
      latestPayslip = {
        month: `${batch.year}-${String(batch.month).padStart(2, "0")}`,
        netSalary: Number(record.net_salary),
      };
    }
  }

  // Await all MR + manager promises together (they've been in-flight since the start).
  const [mrSalesResult, dvResult, expenseResult, managerPlanResult] = await Promise.allSettled([
    mrSalesPromise,
    dvPromise,
    expensePromise,
    managerPlanCountPromise,
  ]);

  // Current-month achievement and the last 4 uploaded months — one canonical load, both shapes.
  const mrCanonical = mrSalesResult.status === "fulfilled" ? mrSalesResult.value : null;
  const mrSalesAchievement: PortalHomeSnapshot["mrSalesAchievement"] = mrCanonical?.current ?? null;
  const monthlySalesTrend: PortalHomeSnapshot["monthlySalesTrend"] = mrCanonical?.trend ?? null;

  // Double-visit pulse for this MR.
  let doubleVisitPulse: PortalHomeSnapshot["doubleVisitPulse"] = null;
  try {
    const dvData = dvResult.status === "fulfilled" ? dvResult.value : null;
    if (Array.isArray(dvData)) {
      const rows = dvData as Array<{ visit_date: string }>;
      const thisMonthPrefix = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;
      if (rows.length === 0) {
        doubleVisitPulse = { daysSinceLastDv: null, dvsThisMonth: 0, dvsLast90Days: 0 };
      } else {
        const lastDate = new Date(rows[0].visit_date);
        const daysSinceLastDv = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
        const dvsThisMonth = rows.filter((r) => r.visit_date.startsWith(thisMonthPrefix)).length;
        const dvsLast90Days = rows.filter((r) => r.visit_date >= ninetyDaysAgo).length;
        doubleVisitPulse = { daysSinceLastDv, dvsThisMonth, dvsLast90Days };
      }
    }
  } catch {
    // null on failure
  }

  // Pending submitted expenses count.
  let mrPendingExpenseCount: PortalHomeSnapshot["mrPendingExpenseCount"] = null;
  try {
    const expData = expenseResult.status === "fulfilled" ? expenseResult.value : null;
    if (expData && "count" in expData && expData.count !== null) {
      mrPendingExpenseCount = expData.count;
    }
  } catch {
    // null on failure
  }

  // Plans awaiting this manager's approval.
  let plansAwaitingManagerApproval: PortalHomeSnapshot["plansAwaitingManagerApproval"] = null;
  try {
    const mpData = managerPlanResult.status === "fulfilled" ? managerPlanResult.value : null;
    if (mpData && "count" in mpData && mpData.count !== null) {
      plansAwaitingManagerApproval = mpData.count;
    }
  } catch {
    // null on failure
  }

  // Pure calculation — no DB.
  const balance = getVacationBalancePeriod({ hireDate: shell.hrContract.hireDate, referenceDate: today });
  const [roleExtras, dvFocus, earlyBirdStars] = await Promise.all([
    roleExtrasPromise,
    dvFocusPromise,
    // Computed OUTSIDE the role branches: it is the same three line-stars for every audience, so
    // resolving it per role would be the same query many times over. Degrades to [] like every
    // other snapshot field — a missing announcement must never fail a landing page.
    getLatestLineEarlyBirds().catch(() => []),
  ]);

  return {
    shell,
    role,
    earlyBirdStars,
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    latestPayslip,
    leaveEntitlementDays: balance?.entitlementDays ?? null,
    mrSalesAchievement,
    monthlySalesTrend,
    doubleVisitPulse,
    mrPendingExpenseCount,
    ...roleExtras,
    plansAwaitingManagerApproval,
    dvFocus,
  };
}
