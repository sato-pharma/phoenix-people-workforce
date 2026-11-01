import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { queryVisitsLimited } from "@/lib/crm/reads";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getKpisBoard, kpiMonthOptions } from "@/lib/crm/kpis-board";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { devSafePromiseAllSettled } from "@/lib/utils/dev-safe-promise-all";
import { isReviewPeriod, windowLabel } from "@/lib/business-review/period-format";
import { getVacationBalancePeriod } from "@/lib/vacation/calculations";
import { getEmployeeAnnualLeaveBalanceDays } from "@/lib/vacation/service";
import { interviewCalendarCaller, listMyUpcomingInterviews } from "@/lib/recruitment/interview-calendar";
import type { ManagerFolderSummary } from "@/lib/recruitment/manager-cv-folders";
import { loadManagerCvFolderSummary } from "@/lib/recruitment/manager-cv-folders-summary";
import type { InterviewPlatform } from "@/lib/recruitment/interview-calendar-types";
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
import { personNameLookup } from "@/lib/employees/person-name-lookup";
import { approvedMarketingRequestStatuses, getMarketingOverview, type MarketingOverviewMetrics } from "@/lib/marketing-requests/service";
// NOTE there is deliberately no `getAwaitingMyActionItems` import here any more.
//
// The DSM, NSM and RM branches each used to call it, take `.length`, and hand the number out as
// `pendingApprovals` — which no component ever rendered. Grepping `app/` and `src/components/` for
// the field returns nothing outside this file, and all three dashboards (dsm-command-center,
// nsm-command-center, rm-command-center) destructure the neighbouring fields and skip it.
//
// It was not a free dead field. One "portal" call fans out to SIX data sources — vacation, excuse,
// resignations, contract renewals, plans awaiting action, and the whole employee directory — so
// every District, National Sales and Regional Manager paid for all six on every landing-page load
// to compute a number that was then dropped.
//
// Nothing is lost by removing it: the same count already reaches these users through the sidebar's
// `approvals-hub-pending` NavBadge, which reads `/api/approvals-hub/pending-count` — the same
// `getAwaitingMyActionItems(access, "portal")` behind one shared endpoint
// (`src/components/employee-portal/employee-portal-layout.tsx`). The function keeps four other live
// callers, so this removes a caller, not the capability.
import { countPlanAwaiting } from "@/lib/approvals-hub/service";
import { getDoubleVisitPortalFocus } from "@/lib/double-visit-analytics/service";
import type { DoubleVisitPortalFocus } from "@/lib/double-visit-analytics/types";
import { getNsmCrmCompliance, nsmCrmComplianceUnavailable, type NsmCrmComplianceData } from "@/lib/employee-portal/nsm-crm-compliance";
import { loadRepRankStanding, type RepRankStanding } from "@/lib/employee-portal/rep-rank";
import { resolveServingRoster, servingRosterManagers } from "@/lib/employee-portal/serving-roster";
import { getLatestLineEarlyBirds, type EarlyBirdsWinnerRecord } from "@/lib/early-birds/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { logError } from "@/lib/observability/log";
import { loadPortalPlanAdherence, type PortalPlanAdherence } from "@/lib/weekly-planning/plan-adherence-data";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import {
  loadEmployeeMonthlyAchievement,
  publishedPointsOnly,
  type MonthlyAchievementPoint,
} from "@/lib/sales/employee-achievement";
import { SALES_VS_TARGET_FLOOR } from "@/lib/sales/vs-target";

/**
 * The MR landing figures, from SoS Monthly Closing — the same engine as Monthly Closing and
 * /sales-vs-target, so the number a rep sees on their home page equals the number their DM,
 * the closing view and the incentive tab see for the same month (Rule #1).
 *
 * Both figures use PUBLISHED closing months only — the same gate every other sales surface uses
 * (publishedPointsOnly → isRowPublished). [Owner ruling, 2026-08-13, restated 2026-09-29]: the
 * keycard shows a month ONLY once its Monthly Closing is published for that rep's line, never a
 * live-but-unclosed number. So the current Cairo month never appears while it is still running:
 * on 2026-09-28 September held a single approved Direct Order (`DirectReq`, 115,632 EGP) against a
 * live target, and the card must still show AUGUST — the latest published month — until the owner
 * publishes September, at which point it switches on its own. An unpublished current month returns
 * null, and the fallback below draws the newest published month with its own label. This replaced
 * the earlier `uploaded` gate, which let that unfinished September through because a distributor
 * import batch (the `DirectReq` pseudo-distributor) existed for the month.
 */
async function loadMrCanonicalSales(hrId: string, period?: string): Promise<{
  current: { achievementPercent: number; salesValue: number; targetValue: number } | null;
  trend: Array<{ year: number; month: number; achievementPercent: number; salesValue: number; targetValue: number }> | null;
  /**
   * THE MONTH THE ACHIEVEMENT TILE WILL ACTUALLY SHOW — the picked month when it is published with
   * a target, otherwise the newest published month on the trend that has one, otherwise null.
   *
   * It exists so the tile's own label and the rank badges beneath it cannot name two different
   * months. The tile has fallen back to the newest published month since 2026-10-01 (the owner's
   * own ruling, see the component), so "the month on screen" is NOT `kpiMonth` and deriving it
   * twice — once for the label, once for the rank — is how the badge would quote August's rank
   * under a September heading. One value, computed here, read by both.
   */
  effectivePeriod: string | null;
}> {
  const { year, month } = currentCairoDateParts();
  // `period` is THE MONTH ON SCREEN, not always the running one. The rep's landing keycards carry a
  // month picker since 2026-10-01 (owner: "I want to be able in overview landing page to choose the
  // month of the KPIs"), and on the 1st of a month the running month has nothing in it at all — no
  // published closing, no visits — so every keycard read empty until he could name the month he
  // wanted. When he names one, `current` means the month he named, and the window ends there.
  const currentPeriod = period ?? `${year}-${String(month).padStart(2, "0")}`;
  // FROM THE PUBLICATION FLOOR, NOT THE HISTORY FLOOR (PERF-022, 2026-10-04). Only PUBLISHED months
  // survive `publishedPointsOnly`, and nothing before SALES_VS_TARGET_FLOOR (2026-07) can be
  // published — loadEmployeeMonthlyAchievement clamps its publication read to that floor, so every
  // Jan–Jun point came back `published: false` and was thrown away. Reading those six months was
  // pure cost on every rep's landing. A picked month before the floor still answers nothing, as it
  // did: the window is then empty rather than holding unpublishable months.
  const window = await loadEmployeeMonthlyAchievement([hrId], SALES_VS_TARGET_FLOOR, currentPeriod);
  const points = publishedPointsOnly(window.byHrId.get(hrId) ?? []);
  if (points.length === 0) return { current: null, trend: null, effectivePeriod: null };

  const percentOf = (point: MonthlyAchievementPoint) =>
    point.achievementValue != null ? point.achievementValue * 100 : 0;

  const currentPoint = points.find((point) => point.period === currentPeriod) ?? null;
  // Newest first, and never capped by a row limit — the engine returns one row per month,
  // so a high-volume rep cannot lose a month to pagination the way the old 200-row cap allowed.
  const newestFirst = points.slice().sort((left, right) => right.period.localeCompare(left.period)).slice(0, 4);
  return {
    current: currentPoint
      ? {
          achievementPercent: percentOf(currentPoint),
          salesValue: currentPoint.actualValue,
          targetValue: currentPoint.targetValue,
        }
      : null,
    // The SAME four points the tile's `closed` list is built from, and the same `targetValue > 0`
    // test: a published month with no target is 0% by arithmetic, not by performance, so it is
    // neither drawn nor eligible to be the fallback. Reading all of `points` here instead of these
    // four would let a 5th-newest month become the tile's month, which the tile would never show.
    effectivePeriod:
      currentPoint && currentPoint.targetValue > 0
        ? currentPeriod
        : (newestFirst.find((point) => point.targetValue > 0)?.period ?? null),
    trend: newestFirst.map((point) => {
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

/** The three sales-manager seats that hold CV folders on the organogram (owner, 2026-10-16). */
const CV_FOLDER_ROLES = new Set(["District Manager", "Regional Manager", "National Sales Manager"]);

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
/**
 * Split a performance roster into the people still employed and the people who have left.
 *
 * The DIRECTORY is the authority on employment here, never the sales rows. Source of Sales keeps a
 * rep's July money after they resign in August — correct, the money was earned — but it means a
 * leaver keeps surfacing on their manager's leaderboard for as long as the achievement window
 * still includes a month they worked. On 2026-09-03 two of the seven names on one district
 * manager's board had already left (last working days 2026-08-09 and 2026-08-17) and the owner
 * asked, plainly, how he was still seeing them.
 *
 * Their SALES stay in the headline totals. Only the people lists and head counts are filtered, and
 * `departed` is returned rather than discarded so a caller can say out loud how much of its own
 * total is carried by names it is not showing.
 *
 * FAIL-OPEN: when the directory read came back empty, EVERY row is treated as active. A failed
 * lookup must never quietly empty a manager's team.
 */
export function splitDepartedRoster<T extends { hrId: string }>(
  roster: readonly T[],
  directoryRows: readonly EmployeeDirectoryRow[],
): { active: T[]; departed: T[] } {
  const key = (value?: string | null) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const activeKeys = new Set(
    directoryRows.filter(isActiveDirectoryEmployee).map((row) => key(row.hrId)).filter(Boolean),
  );
  if (activeKeys.size === 0) return { active: [...roster], departed: [] };
  const active: T[] = [];
  const departed: T[] = [];
  for (const row of roster) (activeKeys.has(key(row.hrId)) ? active : departed).push(row);
  return { active, departed };
}

export function activeRosterOnly<T extends { hrId: string }>(
  roster: readonly T[],
  directoryRows: readonly EmployeeDirectoryRow[],
): T[] {
  return splitDepartedRoster(roster, directoryRows).active;
}

/** Total sales carried by rows that are being filtered off a leaderboard. */
function sumSales(rows: readonly { totalSales: number }[]): number {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.totalSales) ? row.totalSales : 0), 0);
}

type DistrictTeamMember = {
  hrId: string;
  name: string;
  achievementPercent: number;
  totalSales: number;
  totalTarget: number;
};

/**
 * The people on a District Manager's landing page: the "My Reps" board, the team size, the leavers
 * note and the CRM first-visit roster, all from the team the sales service returned.
 *
 * THE VIEWER IS NEVER ON HER OWN TEAM. An acting District Manager (app role District Manager, job
 * title Medical Representative, which HR keeps on purpose) still occupies the rep seat of one of the
 * areas she manages, so the sales engine attributes that area's rows to HER as a rep and the team
 * service hands her back as one of her own reps. On 2026-09-21 the one acting District Manager in
 * production saw herself on "My Reps", counted in "Team Size" (3 instead of her 2 reps) and listed
 * red on her own CRM first-visit board. Owner rule: she sees exactly what a District Manager sees,
 * her team and never her own row. A real District Manager holds no rep seat, so for him this
 * removes nothing.
 *
 * Only the PEOPLE lists and the head count drop her. The district's sales, target and achievement
 * stay whole: her area belongs to the district, and her NSM's view of the same district counts it.
 *
 * Leavers come off BEFORE the top-10 slice, never after: a rep who resigned mid-window still carries
 * real sales, so filtering afterwards would let a departed name hold one of the ten slots and push a
 * serving rep off the board entirely.
 */
export function districtManagerLandingPeople(
  teamMembers: readonly DistrictTeamMember[],
  directoryRows: readonly EmployeeDirectoryRow[],
  viewerHrId: string | null | undefined,
): {
  members: DistrictTeamMember[];
  memberCount: number;
  departedCount: number;
  departedSales: number;
  crmReps: Array<{ hrId: string; name: string }>;
} {
  // One hyphen- and case-insensitive HR-ID key for every match below (canonical "B100" and stored
  // "B-100" both match), the same key splitDepartedRoster uses.
  const nameKey = (value?: string | null) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  const viewerKey = nameKey(viewerHrId);
  const team = viewerKey ? teamMembers.filter((member) => nameKey(member.hrId) !== viewerKey) : [...teamMembers];

  // Show the nickname when set, else the full name. The performance services return
  // raw full names, so resolve the directory's nickname-aware displayName by that key.
  const displayByKey = new Map<string, string>();
  for (const row of directoryRows) {
    const key = nameKey(row.hrId);
    if (key) displayByKey.set(key, row.displayName);
  }
  const display = (hrId: string | null | undefined, fallback: string) =>
    displayByKey.get(nameKey(hrId)) ?? fallback;

  const roster = splitDepartedRoster(team, directoryRows);
  const members = roster.active
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

  return {
    members,
    // The count of reps she actually has today, not the count of rows with sales in the window —
    // those differ by exactly the people who have since left.
    memberCount: roster.active.length,
    departedCount: roster.departed.length,
    departedSales: sumSales(roster.departed),
    // CRM first-visit compliance covers the FULL serving roster — deliberately not the `members`
    // leaderboard above, which is sliced to the top 10 by achievement. Ranking a compliance board
    // off a sales leaderboard would silently hide every rep outside the top 10 from both the green
    // and the red list.
    crmReps: roster.active.map((m) => ({ hrId: m.hrId, name: display(m.hrId, m.name) })),
  };
}

/**
 * The sales window a performance keycard actually covers, named.
 *
 * These keycards are built with no requested period, which means EVERY PUBLISHED period in the
 * achievement window — not "this month". On 2026-09-03 that was July 2026 alone, while the cards
 * read "achieved this period" and a manager opening them in September had no way to tell which
 * month he was looking at. Owner, 2026-09-03: "you must show this achievement is in which window?"
 *
 * Null when nothing is published; the caller must then say so rather than print a bare number.
 */
export function salesWindowLabel(periods: readonly string[] | null | undefined): string | null {
  const sorted = (periods ?? []).filter(isReviewPeriod).slice().sort();
  if (sorted.length === 0) return null;
  return windowLabel(sorted[0], sorted[sorted.length - 1]);
}

export type UpcomingMarketingActivity = { id: string; requestCode: string; payDate: string; estimatedCost: number };

/**
 * One rep's own row off the CRM KPI board, reduced to what the landing page prints.
 *
 * THE CALL RATE IS TWO NUMBERS, NEVER ONE. AM is scored against its own target and PM against its
 * own, and nothing here — or downstream of here — may add or average the pair (owner, 2026-09-04).
 * That is why there is no combined field to reach for.
 */
export type MrFieldKpis = {
  monthLabel: string;
  /** Doctors the plan names — the single denominator under BOTH plan percentages. */
  plannedDoctors: number;
  visitedDoctors: number;
  missedDoctors: number;
  /** Doctors seen at exactly the planned frequency — the numerator under frequencyPct, NOT coverage. */
  onPlanDoctors: number;
  /** Planned doctors visited MORE times than planned — a deviation on the owner's rule. Always 0
   *  under the Phoenix rules, where an extra visit is not counted against the rep. */
  overDoctors: number;
  /** Planned doctors visited at least once but FEWER times than planned. */
  underDoctors: number;
  coveragePct: number;
  frequencyPct: number;
  /** False when the rep has no planned doctors at all. He must not render as 0%. */
  hasMeasurablePlan: boolean;
  workingDays: number;
  amVerified: number;
  pmVerified: number;
  amRate: number | null;
  pmRate: number | null;
  amTarget: number;
  pmTarget: number;
  /**
   * Separate from AM/PM entirely (owner, 2026-09-05): "am/pm coverage and call rate are separate
   * from pharmacies coverage and call rate". `pharmacyTarget` is null — no owner-set standard
   * exists yet, see PHARMACY_CALL_RATE_TARGET — never invent one here.
   */
  pharmacyVerified: number;
  pharmacyRate: number | null;
  pharmacyTarget: number | null;
  /** False when the rep logged nothing in the window — distinct from a real zero rate. */
  hasCallRate: boolean;
  /** Ruling A1 (owner, 2026-09-21): calls logged, no GPS check-in to prove them — the tile says so
   * rather than printing the blank proved rates as zeros. See `KpiRepRow.noGpsFeed`. */
  noGpsFeed?: boolean;
  /** "phoenix" from the CRM cutover, when every submitted regular visit counts (phase 6). */
  kpiRules?: "legacy" | "phoenix";
};

/** One of this person's own upcoming interviews, for the "My interviews" card on the portal home. */
export type PortalMyInterview = {
  id: string;
  candidateName: string;
  dateKey: string;
  startMinutes: number;
  durationMinutes: number;
  platform: InterviewPlatform;
  zoomJoinUrl: string | null;
};

/** A landing card's read: still running when the page asked for it to be streamed, in hand otherwise. */
export type Streamed<T> = T | Promise<T>;

export type PortalHomeSnapshot = {
  shell: EmployeePortalShellData;
  role: string;
  /**
   * This person's OWN upcoming interviews — the ones they conduct (interviewer) or asked for
   * (requester), from today forward. Empty for almost everyone; the card renders nothing rather than
   * an empty box, so it appears only for people who actually have an interview coming up. This is
   * what makes the calendar relevant on the home page daily (owner, 2026-09-26).
   */
  myInterviews: Streamed<PortalMyInterview[]>;
  /** This fortnight's stars, one per line, shown as a compact card on every audience's landing
   * page. Empty until the first fortnight is confirmed — the card renders nothing rather than an
   * empty box. */
  earlyBirdStars: Streamed<EarlyBirdsWinnerRecord[]>;
  pendingVacationCount: number;
  pendingExcuseCount: number;
  /**
   * False when either pending-count query failed/timed out. Counts stay 0 for arithmetic, but the
   * UI must show a "couldn't load" state instead of a misleading "All clear" green banner (honest
   * empty state — a failed source must never read as "nothing needs your attention").
   */
  pendingCountsAvailable: boolean;
  /**
   * How closely this person's own weekly plans matched what the CRM recorded — their latest scored
   * period plus a running average, with a link through to where the mismatches are.
   *
   * Null for anyone who has never filed a plan, which is most of the company: the plan module is
   * managers only (20 people on production; no medical rep has ever submitted one). A card reading
   * "no score" on hundreds of dashboards would be noise, so there is no card at all.
   */
  planAdherence: Streamed<PortalPlanAdherence | null>;
  latestPayslip: { month: string; netSalary: number } | null;
  leaveEntitlementDays: number | null;
  /**
   * Annual leave DAYS LEFT — entitlement minus every already-approved paid day taken this balance
   * period, via getEmployeeAnnualLeaveBalanceDays (the Vacation Report's own entitlement-row math),
   * never a second copy of the subtraction. Distinct from leaveEntitlementDays above, which is the
   * raw yearly grant some dashboards (Product Manager/GPM) deliberately still show labelled
   * "annual entitlement" — do not repoint those at this field, and do not repoint this one at the
   * entitlement figure. Null only when the balance could not be computed (no employee match).
   */
  leaveDaysRemaining: number | null;
  mrSalesAchievement: { achievementPercent: number; salesValue: number; targetValue: number } | null;
  monthlySalesTrend: Array<{ year: number; month: number; achievementPercent: number; salesValue: number; targetValue: number }> | null;
  /**
   * The month the Medical Rep's Achievement tile is actually showing, `YYYY-MM`, or null when
   * nothing is published for them. NOT `kpiMonth`: the tile falls back to the newest published
   * month (owner, 2026-10-01), so this is the month the tile NAMES and the month the honour badges
   * rank — one value so the two can never disagree. See loadMrCanonicalSales's `effectivePeriod`.
   */
  mrAchievementPeriod: string | null;
  /**
   * The rep's honour badges: top 15 company-wide, top 7 in his own line (owner, 2026-10-03). Null
   * outside both bands, or when nothing is published — and each half is null on its own, so a rep
   * can hold one badge, two, or none. Never a consolation badge.
   *
   * 🔒 THE WINDOW IS CUMULATIVE AND IS **NOT** `mrAchievementPeriod` (owner, 2026-10-03: "do not
   * calculate only August, calculate up to date — example for now 7 and 8, when 9 closing is
   * published then 7 8 9"). The keycard shows ONE month; this ranks every published month summed.
   * The standing carries its own `windowLabel`, which the badge prints, so the two are never read
   * as the same number.
   */
  mrRankStanding: RepRankStanding | null;
  doubleVisitPulse: { daysSinceLastDv: number | null; dvsThisMonth: number; dvsLast90Days: number } | null;
  /**
   * This rep's own field KPIs for the running month, straight from the CRM KPI board rather than
   * a second implementation of the same arithmetic — coverage, frequency and the AM/PM call rate.
   *
   * Null when the board could not answer. The two `has*` flags carry the difference between a real
   * zero and no basis to score at all, which the tiles must render differently: a rep with no plan
   * is NOT a 0% performer.
   */
  mrFieldKpis: MrFieldKpis | null;
  /**
   * The month every Medical Rep keycard on the landing page is showing, `YYYY-MM` — coverage,
   * frequency, the call rate AND achievement, so the four of them can never describe four different
   * windows. It is the running Cairo month unless the rep picked another one (owner, 2026-10-01).
   *
   * Validated against `kpiMonthOptions` here and nowhere else: the value arrives off the URL, so the
   * page hands it over raw and this is the ONE gate that decides what a month may be. A month the
   * list does not hold falls back to the running month rather than reaching a query.
   */
  kpiMonth: string;
  /**
   * The months the picker offers — newest first, stopping at the CRM data floor. Built on the server
   * from `kpiMonthOptions`, the same list the KPIs board's own picker uses, and carried as plain data
   * because the picker is a client component and that module's dependency chain reaches the Supabase
   * admin client (see the note in components/crm/kpis-period-picker.tsx: importing it in the browser
   * bundle 500s at runtime while `tsc` stays happy).
   */
  kpiMonthOptions: Array<{ label: string; value: string }>;
  mrPendingExpenseCount: number | null;
  /** Product / Group Product Manager only: the PM's own marketing requests still in flight + upcoming pay dates. */
  pmMarketing: { myPendingRequests: number; upcoming: UpcomingMarketingActivity[] } | null;
  /**
   * Marketing Manager only: company-wide approval/validation pipeline counts + upcoming pay dates
   * (company-wide). `asOf` is a server-stamped epoch (ms) so the dashboard can compute inbox aging
   * without calling Date.now() during render (which is impure for a React component).
   */
  mmOverview: (MarketingOverviewMetrics & { upcoming: UpcomingMarketingActivity[]; asOf: number }) | null;
  /** District Manager only: the DSM's own med-rep team, current period, + the CRM first-visit board
   * for that team. `members` is the top-10 sales leaderboard; `crm` covers every direct report,
   * ranked and uncapped. */
  dsmTeam:
    | {
        achievementPercent: number;
        memberCount: number;
        totalSales: number;
        totalTarget: number;
        /** Which published month(s) these numbers cover, e.g. "Jul 2026". Null when none is
         *  published — the keycards must then say so rather than print a bare number. */
        windowLabel: string | null;
        /** Reps who left during the window: excluded from `members` and `memberCount`, but their
         *  sales are still inside `totalSales`, which is what `departedSales` accounts for. */
        departedCount: number;
        departedSales: number;
        members: Array<{ hrId: string; name: string; achievementPercent: number; totalSales: number; totalTarget: number }>;
        crm: NsmCrmComplianceData;
      }
    | null;
  /** National Sales Manager only: the NSM's line, rolled up by DSM. */
  nsmNational:
    | {
        achievementPercent: number;
        dsmCount: number;
        totalSales: number;
        totalTarget: number;
        /** Which published month(s) these numbers cover. See dsmTeam.windowLabel. */
        windowLabel: string | null;
      }
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
        /** People who left during the window: off both leaderboards, still inside the line total. */
        departedCount: number;
        departedSales: number;
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
        /** Which published month(s) these numbers cover. See dsmTeam.windowLabel. */
        windowLabel: string | null;
        /** People who left during the window: off both leaderboards, still inside the region total. */
        departedCount: number;
        departedSales: number;
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
  /**
   * False when the plans-awaiting-approval lookup failed rather than genuinely finding zero.
   * Same idea as pendingCountsAvailable above — see resolvePlansAwaitingApproval. Every dashboard
   * that folds plansAwaitingManagerApproval into a "pending" total must gate on this too, or a
   * failed lookup (defaulting to 0) silently understates that total instead of reading as unknown.
   */
  plansCountAvailable: boolean;
  /** DM/RM/NSM/PM/GPM/TM only: personal DV trend, scope coverage, and probation DV watchlist. */
  dvFocus: DoubleVisitPortalFocus | null;
  /**
   * District, Regional and National Sales Manager only: the CV folders on this manager's shelf and how
   * many of the CVs in them are still unopened (owner, 2026-10-16). Null for anybody who holds no
   * shelf, so the overview row is absent rather than reading "0 folders".
   */
  cvFolders?: Streamed<ManagerFolderSummary | null>;
  /**
   * Medical Rep only, and only when the page asked for it (`streamRepCards`): the four slow reads of
   * the rep's landing, handed over STILL RUNNING so the page can paint at once and fill each card the
   * moment its own read lands (owner, 2026-10-23: "the process of shifting from page to page never
   * take more than 1 second"). While this is set, the seven fields it carries — achievement, the
   * trend, the achievement month, the rank, the field KPIs, the leave left and the double-visit pulse
   * — are null on the snapshot itself and must be read from here. Absent everywhere else, so every
   * other caller (the home API route, the Training Manager page) still gets a whole snapshot.
   */
  repCards?: PortalHomeRepCards | null;
  /**
   * District, Regional and National Sales Manager and the Marketing Manager only, and only when the
   * page asked for it (`streamRoleExtras`): the role's slow landing reads — the team, region or
   * national figures, the rankings, the CRM first-visit board, the marketing inbox — handed over
   * STILL RUNNING, so the identity band, pending actions and dashboards grid paint without them and
   * each section fills under its own Suspense (2026-10-23, performance roadmap phase 2). While this is
   * set, the six role fields on the snapshot itself are null and must be read from here. It never
   * rejects (`getRoleSpecificExtras` resolves the empty extras on any failure). Absent everywhere
   * else, so the home API route and the Training Manager page still get a whole snapshot.
   */
  roleCards?: Promise<PortalHomeRoleExtras> | null;
  /**
   * District, Regional and National Sales Manager, Product Manager and Group Product Manager only,
   * and only when the page asked for it (`streamDvFocus`): the double-visit focus — the trend, the
   * scope coverage and the probation watchlist at the foot of the landing — handed over STILL
   * RUNNING. It walks every double visit in the company since the trend's first month, and the whole
   * landing used to wait for that walk before it could draw its identity band. While this is set,
   * `dvFocus` on the snapshot itself is null and must be read from here. It never rejects (a failed
   * read resolves null, the same as the awaited field). Absent everywhere else, so the home API route
   * and the Training Manager page still get `dvFocus` whole.
   */
  dvFocusCard?: Promise<DoubleVisitPortalFocus | null> | null;
};

/** What a Medical Rep's achievement tile and his "Achievement by month" panel are drawn from. */
export type PortalHomeRepSales = Pick<PortalHomeSnapshot, "mrSalesAchievement" | "monthlySalesTrend" | "mrAchievementPeriod">;

/**
 * The rep's slow landing reads, one promise per card group. NONE OF THEM EVER REJECTS — a failed
 * read resolves to the same null the awaited snapshot would have carried — so a card can await its
 * own without a boundary, and a page that stops rendering half way leaves no unhandled rejection.
 */
export type PortalHomeRepCards = {
  sales: Promise<PortalHomeRepSales>;
  rankStanding: Promise<RepRankStanding | null>;
  fieldKpis: Promise<MrFieldKpis | null>;
  record: Promise<Pick<PortalHomeSnapshot, "leaveDaysRemaining" | "doubleVisitPulse">>;
};

/** The sales half of the snapshot from one canonical load; a failed load reads as no data, never 0%. */
function repSalesFields(canonical: Awaited<ReturnType<typeof loadMrCanonicalSales>> | null): PortalHomeRepSales {
  return {
    mrSalesAchievement: canonical?.current ?? null,
    monthlySalesTrend: canonical?.trend ?? null,
    mrAchievementPeriod: canonical?.effectivePeriod ?? null,
  };
}

type RoleSpecificExtras = Pick<
  PortalHomeSnapshot,
  "pmMarketing" | "mmOverview" | "dsmTeam" | "nsmNational" | "nsmBoard" | "rmRegional"
>;

/** The six role fields a manager's landing draws its slow sections from — see `roleCards`. */
export type PortalHomeRoleExtras = RoleSpecificExtras;

/**
 * The roles whose landing streams its role extras. The Product Manager and Group Product Manager are
 * left awaited on purpose: their one extra is a single count and a short pay-date list, read inside
 * the portal command center's own layout, so streaming it would add a boundary and save nothing.
 */
// Spelled exactly as PortalCommandCenter's switch spells them: a role that falls through that switch
// to the standard dashboard never reads roleCards, so it must never have its extras streamed away.
const STREAM_ROLE_EXTRAS_ROLES = new Set([
  "District Manager",
  "National Sales Manager",
  "Regional Manager",
  "Marketing Manager",
]);

/**
 * The roles whose landing streams the double-visit focus: exactly the PortalCommandCenter layouts
 * that draw it through `StreamedDoubleVisitFocus`. The Training Manager holds a focus too but is left
 * awaited: her landing never draws it, and her own page reads `dvFocus` off a whole snapshot.
 */
const STREAM_DV_FOCUS_ROLES = new Set([
  "District Manager",
  "National Sales Manager",
  "Regional Manager",
  "Product Manager",
  "Group Product Manager",
]);

/**
 * The reads a role's LANDING page never draws, read off the landing components on 2026-10-31 (the
 * portal home was the slowest page by total waiting time). Each one is still read for the JSON home
 * route and the Training Manager's page, which take the whole snapshot.
 *
 * - payslip: no landing draws it — no payslip on any overview, for any role (portal rules).
 * - planCount: the District and National Sales Manager's pending band shows leave and excuses only.
 * - leaveLeft: those two, the Marketing Manager and the PM/GPM landings show the entitlement, not days left.
 * - earlyBirds: only the four sales and marketing manager landings carry the Early Bird card.
 * - dvFocus: the Training Manager holds a focus, but her landing (the standard one) never draws it.
 */
type LandingSkips = { payslip: boolean; planCount: boolean; leaveLeft: boolean; earlyBirds: boolean; dvFocus: boolean };
const NO_LANDING_SKIPS: LandingSkips = { payslip: false, planCount: false, leaveLeft: false, earlyBirds: false, dvFocus: false };
const LANDING_WITHOUT_PLAN_COUNT = new Set(["District Manager", "National Sales Manager"]);
const LANDING_WITHOUT_LEAVE_LEFT = new Set([
  "District Manager",
  "National Sales Manager",
  "Marketing Manager",
  "Product Manager",
  "Group Product Manager",
]);
const LANDING_WITH_EARLY_BIRDS = new Set(["District Manager", "National Sales Manager", "Regional Manager", "Marketing Manager"]);

export function landingSkips(role: string): LandingSkips {
  return {
    payslip: true,
    planCount: LANDING_WITHOUT_PLAN_COUNT.has(role),
    leaveLeft: LANDING_WITHOUT_LEAVE_LEFT.has(role),
    earlyBirds: !LANDING_WITH_EARLY_BIRDS.has(role),
    dvFocus: DV_FOCUS_ROLES.has(role) && !STREAM_DV_FOCUS_ROLES.has(role),
  };
}

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
  // Cairo's calendar day, not the server's UTC one. Production runs with no TZ variable set, so
  // from 21:00 UTC to midnight — which is 00:00 to 03:00 the NEXT morning in Cairo — a UTC "today"
  // is still yesterday's date here, and this `gte` would keep listing a pay_date already spent.
  const today = cairoTodayIso();
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
type CrmComplianceInput = Parameters<typeof getNsmCrmCompliance>[0];

/** The board's compliance read, failing to its "unavailable" answer exactly as each branch did inline. */
function crmComplianceFor(access: AccessContext, module: string, input: CrmComplianceInput): Promise<NsmCrmComplianceData> {
  return getNsmCrmCompliance(input).catch((error: unknown) => {
    logPortalFailure({ hrId: access.hrId, module, role: access.role, route: "/employee-portals" }, error);
    return nsmCrmComplianceUnavailable(input);
  });
}

/**
 * 🔴 STARTED THE MOMENT THE ORG TREE ANSWERS, BESIDE THE SALES READS (performance brief, 2026-10-23). When the
 * serving roster resolves, the compliance input is built from it ALONE — the sales rows are only its fallback —
 * so the read no longer waits for the slower sales services to finish first. A null roster answers null here
 * and the branch builds its fallback input after the sales rows land, exactly as before. A roster that throws
 * is the branch's own failure (its Promise.all rejects), so this side only swallows it.
 */
function crmComplianceFromRoster(
  rosterPromise: Promise<Awaited<ReturnType<typeof resolveServingRoster>>>,
  run: (roster: NonNullable<Awaited<ReturnType<typeof resolveServingRoster>>>) => Promise<NsmCrmComplianceData>,
): Promise<NsmCrmComplianceData | null> {
  return rosterPromise.then((roster) => (roster ? run(roster) : null)).catch(() => null);
}

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
      // servingRoster is the ORG TREE's answer to "who is on my team today", resolved alongside the
      // sales call and never from it. getDsmTeamPerformance is membership-by-sales-history, so it is
      // gated on a published closing — see serving-roster.ts for the day that blanked a whole
      // district's head count and CRM board.
      const rosterPromise = resolveServingRoster({ viewerHrId: hrId, label: "your district" });
      const earlyCrm = crmComplianceFromRoster(rosterPromise, (roster) =>
        crmComplianceFor(access, "dsm-crm-compliance", { reps: roster.reps, dsms: [], limit: Number.POSITIVE_INFINITY }),
      );
      const [team, directoryRows, servingRoster] = await Promise.all([
        // Ranked by who made the sales: each month goes to the rep who held the seat then (owner, 26 Oct 2026).
        getDsmTeamPerformance(access, { creditRepsByTenure: true }),
        getEmployeeDirectoryRows().catch(() => []),
        rosterPromise,
      ]);
      if (!team) return emptyRoleExtras;

      // Every person on this landing page comes from ONE call, which is where the viewer herself is
      // taken off her own team (an acting District Manager also holds a rep seat under her) and
      // where leavers are split out. See districtManagerLandingPeople.
      const people = districtManagerLandingPeople(team.members ?? [], directoryRows, hrId);

      // CRM first-visit compliance over the DM's FULL serving roster, not the top-10 leaderboard.
      // `dsms: []` because a District Manager anchors med reps only (getDsmTeamPerformance runs in
      // "dsm-direct" mode), and the board is uncapped so nobody on a team this size drops off the
      // ranking.
      const crmInput = {
        // The org tree's roster, falling back to the sales roster only when no seat could be
        // resolved. "Who started work today" must never go quiet because a closing is unpublished.
        reps: servingRoster?.reps ?? people.crmReps,
        dsms: [],
        limit: Number.POSITIVE_INFINITY,
      };
      const crm = (await earlyCrm) ?? (await crmComplianceFor(access, "dsm-crm-compliance", crmInput));

      return {
        ...emptyRoleExtras,
        dsmTeam: {
          achievementPercent: team.teamAchievementPercent,
          // The head count is a fact about her team, not about a closing.
          memberCount: servingRoster?.reps.length ?? people.memberCount,
          totalSales: team.teamTotalSales,
          totalTarget: team.teamTotalTarget,
          windowLabel: salesWindowLabel(team.periods),
          departedCount: people.departedCount,
          departedSales: people.departedSales,
          members: people.members,
          crm,
        },
      };
    }
    if (role === "National Sales Manager") {
      // See the District Manager branch: servingRoster answers "who is in my line today" from the
      // org tree, so the daily board and the head count never ride on a published closing.
      const rosterPromise = resolveServingRoster({ viewerHrId: hrId, label: "your line" });
      const earlyCrm = crmComplianceFromRoster(rosterPromise, (roster) =>
        crmComplianceFor(access, "nsm-crm-compliance", { reps: roster.reps, dsms: servingRosterManagers(roster) }),
      );
      const [national, repTeam, directoryRows, servingRoster] = await Promise.all([
        getNsmDsmPerformance(access, {}),
        // Ranked by who made the sales: each month goes to the rep who held the seat then (owner, 26 Oct 2026).
        getDsmTeamPerformance(access, { creditRepsByTenure: true }),
        getEmployeeDirectoryRows().catch(() => []),
        rosterPromise,
      ]);
      if (!national) return emptyRoleExtras;

      // Every name on this board — district managers, reps, and the manager printed beside each top
      // rep — goes through personNameLookup: the directory's nickname-aware name, then the employees
      // row for anyone who has LEFT (a resigned manager still heads a rep's sales window, and printed
      // in the sales file's raw capitals until 2026-10-26), then a capitals tidy.
      const display = await personNameLookup(directoryRows, [
        ...national.dsms.map((d) => d.hrId),
        ...(repTeam?.members ?? []).flatMap((m) => [m.hrId, m.managerHrId]),
      ]);

      // Same rule as the district board: people who have left come off the leaderboards before the
      // slice, and their sales stay in the line total (see splitDepartedRoster).
      const dsmRoster = splitDepartedRoster(national.dsms, directoryRows);
      const repRoster = splitDepartedRoster(repTeam?.members ?? [], directoryRows);
      const dsms = dsmRoster.active.map((d) => ({
        hrId: d.hrId,
        name: display(d.hrId, d.name),
        achievementPercent: d.achievementPercent,
        totalSales: d.totalSales,
        totalTarget: d.totalTarget,
      }));

      const repMembers = repRoster.active;
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

      // CRM first-visit compliance over the full line roster (all reps + every manager), not just the
      // top 10, and off the org tree rather than the sales rows — the sales fallback stays for a seat
      // the tree cannot resolve. The managers are the Regional Manager AND the district managers: the
      // board left the Regional Manager out until 2026-10-20 (owner, 2026-10-20; serving-roster.ts).
      const crmInput = {
        reps:
          servingRoster?.reps ??
          activeRosterOnly(
            repMembers.map((m) => ({ hrId: m.hrId, name: display(m.hrId, m.name) })),
            directoryRows,
          ),
        dsms: servingRoster
          ? servingRosterManagers(servingRoster)
          : activeRosterOnly(
              dsms.map((d) => ({ hrId: d.hrId, name: d.name })),
              directoryRows,
            ),
      };
      const crm = (await earlyCrm) ?? (await crmComplianceFor(access, "nsm-crm-compliance", crmInput));

      return {
        ...emptyRoleExtras,
        nsmNational: {
          achievementPercent: national.lineAchievementPercent,
          // A count of his districts, not of the districts that booked published sales.
          dsmCount: servingRoster?.dsms.length ?? dsmRoster.active.length,
          totalSales: national.lineTotalSales,
          totalTarget: national.lineTotalTarget,
          windowLabel: salesWindowLabel(national.periods),
        },
        nsmBoard: {
          dsms,
          topReps,
          crm,
          departedCount: dsmRoster.departed.length + repRoster.departed.length,
          departedSales: sumSales(dsmRoster.departed) + sumSales(repRoster.departed),
        },
      };
    }
    if (role === "Regional Manager") {
      // See the District Manager branch: the org tree, not the sales rows, says who is in the region.
      const rosterPromise = resolveServingRoster({ viewerHrId: hrId, label: "your region" });
      const earlyCrm = crmComplianceFromRoster(rosterPromise, (roster) =>
        crmComplianceFor(access, "rm-crm-compliance", { reps: roster.reps, dsms: servingRosterManagers(roster) }),
      );
      const [regional, directoryRows, servingRoster] = await Promise.all([
        getRmRegionalPerformance(access, {}),
        getEmployeeDirectoryRows().catch(() => []),
        rosterPromise,
      ]);
      if (!regional) return emptyRoleExtras;

      // Same name resolution as the line board above, departed managers included (personNameLookup).
      const display = await personNameLookup(directoryRows, [
        ...regional.dsms.map((d) => d.hrId),
        ...regional.topReps.flatMap((m) => [m.hrId, m.managerHrId]),
      ]);

      // Same rule as the district and line boards — see splitDepartedRoster.
      const dsmRoster = splitDepartedRoster(regional.dsms, directoryRows);
      const repRoster = splitDepartedRoster(regional.topReps, directoryRows);
      const dsms = dsmRoster.active.map((d) => ({
        hrId: d.hrId,
        name: display(d.hrId, d.name),
        achievementPercent: d.achievementPercent,
        totalSales: d.totalSales,
        totalTarget: d.totalTarget,
      }));

      const topReps = repRoster.active.slice(0, 10).map((m) => ({
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
        reps:
          servingRoster?.reps ??
          activeRosterOnly(
            regional.topReps.map((m) => ({ hrId: m.hrId, name: display(m.hrId, m.name) })),
            directoryRows,
          ),
        // The same manager tier as the line board; a region holds no other Regional Manager, so in
        // practice this is his district managers.
        dsms: servingRoster
          ? servingRosterManagers(servingRoster)
          : activeRosterOnly(
              dsms.map((d) => ({ hrId: d.hrId, name: d.name })),
              directoryRows,
            ),
      };
      const crm = (await earlyCrm) ?? (await crmComplianceFor(access, "rm-crm-compliance", crmInput));

      return {
        ...emptyRoleExtras,
        rmRegional: {
          achievementPercent: regional.regionAchievementPercent,
          // A count of his districts, not of the districts that booked published sales.
          dsmCount: servingRoster?.dsms.length ?? dsmRoster.active.length,
          totalSales: regional.regionTotalSales,
          totalTarget: regional.regionTotalTarget,
          unattributedSales: regional.unattributedSales,
          windowLabel: salesWindowLabel(regional.periods),
          departedCount: dsmRoster.departed.length + repRoster.departed.length,
          departedSales: sumSales(dsmRoster.departed) + sumSales(repRoster.departed),
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

/**
 * The rep's own KPI row, by asking the board that already owns this arithmetic.
 *
 * `getKpisBoard` resolves scope through `getDoctorCoverageScope`, and a medical rep's scope is
 * himself, so the board comes back holding his single row. Matching is done on the hr id with BOTH
 * sides lower-cased: production hr ids are mixed case, and a plain equality check silently
 * under-returns.
 */
async function loadMrFieldKpis(access: AccessContext, hrId: string, month: string): Promise<MrFieldKpis | null> {
  // `month` is the month on screen; `todayIso` stays Cairo TODAY whatever month that is. Both are
  // needed and they are not interchangeable: `repsPlansRange` scores a window that is entirely in
  // the past to its own end (so a picked September is the whole of September), a window still
  // running only as far as it has run, and it needs the real date to tell those apart. Passing the
  // picked month as `todayIso` would score a past month as though it were still mid-flight.
  const todayIso = cairoTodayIso();
  // `includeReports: false` (2026-10-01, "slow to transfer between page and page"): the tile reads
  // his row and the board's four targets and nothing else, and the two per-rep KPI reports are a
  // whole further read the board makes AFTER its main batch, whose answer is dropped right here.
  // They never touch a row (see getKpisBoard), so every figure on the tile is the one it was.
  const board = await getKpisBoard({ access, includeReports: false, month, todayIso });
  const wanted = hrId.toLowerCase();
  const row =
    board.reps.find((r) => (r.agentHrId ?? "").toLowerCase() === wanted) ??
    (board.reps.length === 1 ? board.reps[0] : null);
  if (!row) return null;
  return {
    monthLabel: board.monthLabel,
    plannedDoctors: row.plannedDoctors,
    visitedDoctors: row.visitedDoctors,
    missedDoctors: row.missedDoctors,
    onPlanDoctors: row.onPlanDoctors,
    overDoctors: row.overDoctors,
    underDoctors: row.underDoctors,
    coveragePct: row.coveragePct,
    frequencyPct: row.frequencyPct,
    hasMeasurablePlan: row.hasMeasurablePlan,
    workingDays: row.workingDays,
    amVerified: row.amVerified,
    pmVerified: row.pmVerified,
    amRate: row.amRate,
    pmRate: row.pmRate,
    amTarget: board.amTarget,
    pmTarget: board.pmTarget,
    pharmacyVerified: row.pharmacyVerified,
    pharmacyRate: row.pharmacyRate,
    pharmacyTarget: board.pharmacyTarget,
    hasCallRate: row.hasCallRate,
    noGpsFeed: row.noGpsFeed,
    kpiRules: board.kpiRules ?? "legacy",
  };
}

const wrapPromise = <T,>(thenable: PromiseLike<T>): Promise<T> =>
  new Promise((resolve, reject) => thenable.then(resolve, reject));

/**
 * Turns the settled result of the plans-awaiting-approval lookup into the pair the snapshot and
 * every consuming dashboard need, distinguishing a real zero from a data source that failed.
 *
 * countPlanAwaiting() (src/lib/approvals-hub/service.ts) never rejects — pinned by
 * tests/portal-home-plan-count-canonical.test.ts, which requires this file keep calling it exactly
 * that way — but it now carries its own `available` flag rather than swallowing a genuine failure
 * into a bare 0: `{ count, available: false }` on a failed lookup, `{ count, available: true }` on
 * a real (possibly zero) count. That inner flag is the primary signal this function reads.
 *
 * The `result.status === "rejected"` branch below is the OUTER safety net, not the main path: it
 * covers anything between the `.then()` and Promise.allSettled itself throwing, or a future change
 * to countPlanAwaiting's never-rejects contract. Either way, a rejection must still read as
 * unavailable rather than silently collapsing to the same 0 a genuine "nothing awaiting approval"
 * produces — a manager cannot tell those apart from a bare number, and "0 plans awaiting your
 * approval" is a positive claim, not a neutral one.
 */
export function resolvePlansAwaitingApproval(
  result: PromiseSettledResult<{ count: number; available: boolean } | null>,
  context: { hrId: string; role: string },
): { plansAwaitingManagerApproval: number | null; plansCountAvailable: boolean } {
  if (result.status === "rejected") {
    logError("Plans-awaiting-manager-approval lookup failed; portal home reports it as unavailable rather than 0", {
      labels: { event: "portal_home_plans_awaiting_approval_failed", hrId: context.hrId, role: context.role },
      error: result.reason,
    });
    return { plansAwaitingManagerApproval: null, plansCountAvailable: false };
  }
  const data = result.value;
  if (data === null) {
    // getPortalHomeSnapshot resolves the underlying promise to null for anyone the plans card does
    // not apply to (medical reps, or a caller with no hrId) — a real "not applicable", not a
    // failure, so it stays available with no count to show.
    return { plansAwaitingManagerApproval: null, plansCountAvailable: true };
  }
  if (!data.available) {
    // countPlanAwaiting() reached its own catch — the underlying query genuinely failed — but
    // resolved rather than rejected, so the failure surfaces HERE instead of at the rejected branch
    // above. Still unavailable: never let this read as a real zero.
    logError("Plans-awaiting-manager-approval lookup failed at the source; portal home reports it as unavailable rather than 0", {
      labels: { event: "portal_home_plans_awaiting_approval_source_failed", hrId: context.hrId, role: context.role },
    });
    return { plansAwaitingManagerApproval: null, plansCountAvailable: false };
  }
  return { plansAwaitingManagerApproval: data.count, plansCountAvailable: true };
}

/**
 * This person's own upcoming interviews for the "My interviews" card — the ones they conduct or
 * asked for, from today forward. Degrades to [] like every snapshot field; the card renders nothing
 * when empty, so most dashboards show nothing extra.
 */
async function loadMyUpcomingInterviews(access: AccessContext): Promise<PortalMyInterview[]> {
  const caller = await interviewCalendarCaller(access);
  const rows = await listMyUpcomingInterviews(caller);
  return rows.map((booking) => ({
    candidateName: booking.candidateName,
    dateKey: booking.dateKey,
    durationMinutes: booking.durationMinutes,
    id: booking.id,
    platform: booking.platform,
    startMinutes: booking.startMinutes,
    zoomJoinUrl: booking.zoomJoinUrl,
  }));
}

export async function getPortalHomeSnapshot(
  access: AccessContext,
  options?: {
    /**
     * The month the rep picked for his landing keycards, straight off the URL and unvalidated.
     * Anything the month list does not hold — a typo, a month before the CRM data floor, a future
     * month, an array from a repeated query parameter — falls back to the running Cairo month.
     */
    kpiMonth?: string | null;
    /**
     * Medical Rep only: hand the four slow reads back unawaited, on `repCards`, instead of holding
     * the whole snapshot for the slowest of them. Only a caller that renders those promises may ask
     * — the landing page does, through Suspense; the JSON home route must not, since a promise
     * serializes to `{}`.
     */
    streamRepCards?: boolean;
    /**
     * District, Regional and National Sales Manager and Marketing Manager only: hand the role extras
     * back unawaited, on `roleCards`. The same rule as `streamRepCards` — only a caller that renders
     * the promise through Suspense may ask; the JSON home route must not.
     */
    streamRoleExtras?: boolean;
    /**
     * The landing's double-visit managers only (see STREAM_DV_FOCUS_ROLES): hand the double-visit
     * focus back unawaited, on `dvFocusCard`. The same rule as `streamRepCards` — only a caller that
     * renders the promise through Suspense may ask; the JSON home route must not.
     */
    streamDvFocus?: boolean;
    /**
     * Every role's landing: hand plan adherence, the person's own interviews, the CV folders and the
     * Early Birds back still running, in their own fields, instead of holding the page for the slowest of
     * them (2026-11-01, "fix the portal home slow opens": plan adherence alone held a manager's landing
     * longer than his identity card and every count together). The same rule as `streamRepCards` — only a
     * caller that renders them through Suspense may ask; the JSON home route must not, since a promise
     * serializes to `{}`.
     */
    streamLandingCards?: boolean;
    /**
     * The landing page only: do not start the reads its role's landing never draws — see
     * `skippedOnLanding` below. Each answers its own empty value, so nothing drawn changes. The JSON home
     * route and the Training Manager's page read the whole snapshot and must not ask.
     */
    landing?: boolean;
  },
): Promise<PortalHomeSnapshot> {
  // STARTED, NOT AWAITED (2026-10-01, "slow to transfer between page and page"). Nothing below needs
  // the shell until the leave balance at the very end, and awaiting it first held every other read
  // of the landing page behind it. A failure still fails the snapshot, exactly as before — at the
  // `await` below — and is handled the moment it starts so it can never surface as an UNHANDLED
  // rejection while the other reads are in flight.
  const shellPromise = getEmployeePortalShellData(access);
  shellPromise.catch(() => undefined);
  const hrId = normalizeHrId(access.hrId) ?? "";
  const role = access.role ?? "";
  const today = cairoTodayIso();
  const supabase = getSupabaseAdmin();
  const isMr = role.toLowerCase() === "medical rep";
  // The rep's sales, rank, field KPIs, leave and double visits are what held his landing page for
  // seconds — 7 s at the median, 21 s at the 90th percentile in production on 2026-10-23 — because
  // the page could draw nothing until the slowest of them had answered. Streamed, they fill their
  // own cards as they land and the page itself paints on the fast reads alone.
  const streamRepCards = options?.streamRepCards === true && isMr && hrId !== "";
  // The same for a sales or marketing manager: his team, region or national figures and the CRM
  // board are the slowest reads of his landing, and nothing else on it waits for them.
  const streamRoleExtras = options?.streamRoleExtras === true && STREAM_ROLE_EXTRAS_ROLES.has(role);
  // And the double-visit focus at the foot of a manager's landing: it walks every double visit since
  // the trend's first month, and nothing above it on the page reads any of it.
  const streamDvFocus = options?.streamDvFocus === true && STREAM_DV_FOCUS_ROLES.has(role);
  // And the four cards any landing may draw, none of which anything above them on the page reads.
  const streamLandingCards = options?.streamLandingCards === true;
  // What this role's LANDING never draws (portal-command-center.tsx and dashboards/*, read 2026-10-31,
  // "fix the slowest five pages"): the home page waited on these reads and then threw them away.
  const skippedOnLanding = options?.landing === true ? landingSkips(role) : NO_LANDING_SKIPS;

  // Start MR sales query + the role-specific KPI extras immediately so they run in parallel
  // with the batch below. getRoleSpecificExtras never throws — it resolves emptyRoleExtras
  // for roles it doesn't recognize and on any internal failure.
  const now = new Date();
  // Cairo's year and month, NOT the server's. Railway production sets no TZ, so `getFullYear()`
  // and `getMonth()` here were UTC's. They feed `thisMonthPrefix` for the double-visit pulse and
  // the 90-day window below, and the damage lands on the 1st of a month: between 00:00 and 03:00
  // Cairo on the 1st, UTC is still the 31st, so "this month" counted the month that just ended —
  // a manager opening his portal after midnight on the 1st saw last month's double visits
  // labelled as the new month's, and the fresh month read zero the moment UTC caught up.
  const { year: currentYear, month: currentMonth } = currentCairoDateParts(now);
  const ninetyDaysAgo = currentCairoDateOnlyIso(new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000));

  // THE MONTH THE KEYCARDS ARE SHOWING — one value, read once, handed to every keycard read below,
  // so coverage, frequency, the call rate and achievement can never end up describing four
  // different windows. The picker rides in the URL exactly as the KPIs board's own does, and the
  // month list is the same `kpiMonthOptions` that board offers rather than a second opinion on which
  // months exist. Validation is membership of that list and nothing else: it already stops at the
  // CRM data floor and starts at the running month, so a future month, a month before the floor and
  // a typo are all refused by the same test, and the fallback is the running month — never an error
  // page, because a landing page that 500s over a query string is worse than one showing this month.
  //
  // The list and the fallback are both taken off `today`, deliberately: deriving either from
  // anywhere else lets the two disagree for the three Cairo hours in which UTC still reads last month.
  const kpiMonths = kpiMonthOptions(today);
  const runningMonth = today.slice(0, 7);
  const requestedKpiMonth = (options?.kpiMonth ?? "").trim();
  const kpiMonth = kpiMonths.some((option) => option.value === requestedKpiMonth)
    ? requestedKpiMonth
    : runningMonth;

  // One canonical load serves BOTH the hero and the 4-month trend — they are the same window.
  const mrSalesPromise = isMr && hrId ? loadMrCanonicalSales(hrId, kpiMonth) : Promise.resolve(null);
  // The honour badges, started BESIDE the sales load, not after it. They rank the whole PUBLISHED
  // window — July and August today, July/August/September the day he publishes September (owner,
  // 2026-10-03) — so they depend on nothing this page computes and have no reason to wait. It costs
  // almost nothing beyond that: loadAchievementRange caches PER MONTH, so the months it asks for are
  // the ones the rep's own history load is already asking for, and the directory behind the leaver
  // filter is TTL-cached. Never rejects — a badge is an ornament on a landing page and must not be
  // able to fail one.
  const mrRankPromise: Promise<RepRankStanding | null> =
    isMr && hrId ? loadRepRankStanding(hrId).catch(() => null) : Promise.resolve(null);
  const fieldKpisPromise: Promise<MrFieldKpis | null> =
    isMr && hrId ? loadMrFieldKpis(access, hrId, kpiMonth).catch(() => null) : Promise.resolve(null);
  const roleExtrasPromise = getRoleSpecificExtras(access, role, hrId);
  const dvFocusPromise: Promise<DoubleVisitPortalFocus | null> = DV_FOCUS_ROLES.has(role) && !skippedOnLanding.dvFocus
    ? getDoubleVisitPortalFocus(access).catch(() => null)
    : Promise.resolve(null);
  // STARTED HERE WITH THE REST (2026-10-01, "slow to transfer between page and page"). These four
  // were only started once every read above had been awaited, so the page paid for them AFTER the
  // slowest of those instead of beside it. Each is independent of everything else in this function
  // and none of them rejects.
  // Computed OUTSIDE the role branches: it is the same three line-stars for every audience, so
  // resolving it per role would be the same query many times over. Degrades to [] like every other
  // snapshot field — a missing announcement must never fail a landing page.
  // Not read at all on the streamed rep landing: the Early Bird card is retired from the Medical
  // Rep's page (owner, 2026-09-30, see the note where it was in portal-command-center.tsx), so
  // waiting for it there was pure cost.
  const earlyBirdStarsPromise: Promise<EarlyBirdsWinnerRecord[]> = streamRepCards || skippedOnLanding.earlyBirds
    ? Promise.resolve([])
    : getLatestLineEarlyBirds().catch(() => []);
  // Also outside the role branches, and for a stronger reason: the plan module's population does not
  // follow the role map. It is DSM, NSM, Product Manager, Group Product Manager AND Training Manager
  // today, and an acting DSM keeps the job title "Medical Representative" (her authority is her app
  // role, not her title). Gating this on a role list would silently drop her. Whether a person has
  // plans is the only honest test, so that is the test — the loader returns null for everyone who
  // has none.
  const planAdherencePromise = hrId ? loadPortalPlanAdherence(hrId).catch(() => null) : Promise.resolve(null);
  // Days LEFT, not the raw entitlement — see leaveDaysRemaining's own doc on PortalHomeSnapshot.
  const leaveDaysRemainingPromise = hrId && !skippedOnLanding.leaveLeft
    ? getEmployeeAnnualLeaveBalanceDays(hrId).catch(() => null)
    : Promise.resolve(null);
  // The CV folders on a sales manager's shelf (owner, 2026-10-16). Started here with the rest; a failed
  // read degrades to no row, because a landing page must never fail over a folder summary.
  const cvFoldersPromise: Promise<ManagerFolderSummary | null> = CV_FOLDER_ROLES.has(role) && hrId
    ? loadManagerCvFolderSummary(hrId).catch(() => null)
    : Promise.resolve(null);
  // The person's own upcoming interviews — outside the role branches, data-driven like plan
  // adherence: whether they have any interview is the only honest test, so that is the test.
  const myInterviewsPromise: Promise<PortalMyInterview[]> = hrId
    ? loadMyUpcomingInterviews(access).catch(() => [])
    : Promise.resolve([]);

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
  // it resolves the responder chain (manager vs CEO step) rather than matching one column. It
  // already resolves to the exact { count, available } shape resolvePlansAwaitingApproval expects,
  // so no reshaping here — wrapping it in an extra `.then((count) => ({ count }))` would nest the
  // whole object under a `count` key instead of passing it through.
  const managerPlanCountPromise =
    !isMr && hrId && !skippedOnLanding.planCount
      ? wrapPromise(countPlanAwaiting(access))
      : Promise.resolve(null);

  // The latest payslip — the newest approved or locked batch, then this employee's record in it —
  // is ONE chain started here and awaited only with the last reads below. It used to sit inside the
  // pending-counts wave and then run its second read on its own, so every non-rep landing waited on
  // two extra sequential round trips before it could paint. It never rejects: a failed read reads as
  // no payslip, exactly as before.
  const latestPayslipPromise: Promise<PortalHomeSnapshot["latestPayslip"]> = hrId && !skippedOnLanding.payslip
    ? (async () => {
        const { data: batch, error: batchError } = await supabase
          .from("salary_batches")
          .select("id, year, month")
          .in("status", ["approved", "locked"])
          .order("year", { ascending: false })
          .order("month", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (batchError || !batch) return null;
        const { data: record } = await supabase
          .from("salary_records")
          .select("net_salary")
          .eq("batch_id", batch.id)
          .eq("hr_id", (canonicalHrIdForDisplay(hrId) ?? hrId.toUpperCase()))
          .maybeSingle();
        if (!record?.net_salary) return null;
        return {
          month: `${batch.year}-${String(batch.month).padStart(2, "0")}`,
          netSalary: Number(record.net_salary),
        };
      })().catch(() => null)
    : Promise.resolve(null);

  // Both fire in parallel (sequential in dev to protect Turbopack workers).
  const [vacationResult, excuseResult] = await devSafePromiseAllSettled([
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
  ]);

  const pendingVacationCount =
    vacationResult.status === "fulfilled" ? (vacationResult.value.count ?? 0) : 0;
  const pendingExcuseCount =
    excuseResult.status === "fulfilled" ? (excuseResult.value.count ?? 0) : 0;
  const pendingCountsAvailable =
    vacationResult.status === "fulfilled" && excuseResult.status === "fulfilled";

  // Await the fast MR + manager counts together (they've been in-flight since the start).
  const [expenseResult, managerPlanResult] = await Promise.allSettled([expensePromise, managerPlanCountPromise]);

  // Double-visit pulse for this MR. Null on failure, never a rejection.
  const doubleVisitPulseFrom = (dvData: unknown): PortalHomeSnapshot["doubleVisitPulse"] => {
    try {
      if (!Array.isArray(dvData)) return null;
      const rows = dvData as Array<{ visit_date: string }>;
      const thisMonthPrefix = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;
      if (rows.length === 0) return { daysSinceLastDv: null, dvsThisMonth: 0, dvsLast90Days: 0 };
      const lastDate = new Date(rows[0].visit_date);
      const daysSinceLastDv = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      const dvsThisMonth = rows.filter((r) => r.visit_date.startsWith(thisMonthPrefix)).length;
      const dvsLast90Days = rows.filter((r) => r.visit_date >= ninetyDaysAgo).length;
      return { daysSinceLastDv, dvsThisMonth, dvsLast90Days };
    } catch {
      return null;
    }
  };

  // Current-month achievement and the last 4 uploaded months — one canonical load, both shapes.
  // Each of these four never rejects (see PortalHomeRepCards), so they can be handed over running.
  const repSalesPromise = mrSalesPromise.then(repSalesFields, () => repSalesFields(null));
  const doubleVisitPulsePromise = dvPromise.then(doubleVisitPulseFrom, () => null);
  const repCards: PortalHomeRepCards | null = streamRepCards
    ? {
        sales: repSalesPromise,
        rankStanding: mrRankPromise,
        fieldKpis: fieldKpisPromise,
        record: Promise.all([leaveDaysRemainingPromise, doubleVisitPulsePromise]).then(
          ([leaveDaysRemaining, doubleVisitPulse]) => ({ leaveDaysRemaining, doubleVisitPulse }),
        ),
      }
    : null;
  // Not streamed — the home API route, the Training Manager page and every other role — waits here,
  // exactly as the whole landing page used to.
  const [repSales, mrRankStanding, mrFieldKpis, doubleVisitPulse] = repCards
    ? [repSalesFields(null), null, null, null]
    : await Promise.all([repSalesPromise, mrRankPromise, fieldKpisPromise, doubleVisitPulsePromise]);
  const { mrSalesAchievement, monthlySalesTrend, mrAchievementPeriod } = repSales;

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

  // Plans awaiting this manager's approval. See resolvePlansAwaitingApproval's own doc: a failed
  // lookup must read as unavailable, never fold into the same 0 a genuine "nothing awaiting" gives.
  const { plansAwaitingManagerApproval, plansCountAvailable } = resolvePlansAwaitingApproval(managerPlanResult, {
    hrId,
    role,
  });

  const shell = await shellPromise;
  // Pure calculation — no DB. employeeHrId is required so a per-employee calendar-year reset
  // (see usesCalendarYearVacationReset in vacation/calculations.ts) applies here exactly as it
  // does on the Vacation Report and the request page — omitting it silently kept this tile on
  // the hire-anniversary reset for an employee whose real period had already rolled over.
  const balance = getVacationBalancePeriod({ employeeHrId: hrId, hireDate: shell.hrContract.hireDate, referenceDate: today });
  const [roleExtras, dvFocus, earlyBirdStars, planAdherence, leaveDaysRemaining, myInterviews, cvFolders, latestPayslip] =
    await Promise.all([
      // Streamed: the role extras ride on roleCards, so the page does not wait for them here.
      streamRoleExtras ? Promise.resolve(emptyRoleExtras) : roleExtrasPromise,
      // Streamed: the double-visit focus rides on dvFocusCard, so the page does not wait for it here.
      streamDvFocus ? Promise.resolve(null) : dvFocusPromise,
      // Streamed: these four ride on their own fields below, so the page does not wait for them here.
      // Each one catches its own failure, which is what makes it safe to hand over running.
      streamLandingCards ? Promise.resolve([]) : earlyBirdStarsPromise,
      streamLandingCards ? Promise.resolve(null) : planAdherencePromise,
      // Streamed: the leave left rides on repCards.record, so the page does not wait for it here.
      repCards ? Promise.resolve(null) : leaveDaysRemainingPromise,
      streamLandingCards ? Promise.resolve([]) : myInterviewsPromise,
      streamLandingCards ? Promise.resolve(null) : cvFoldersPromise,
      latestPayslipPromise,
    ]);

  return {
    shell,
    role,
    myInterviews: streamLandingCards ? myInterviewsPromise : myInterviews,
    earlyBirdStars: streamLandingCards ? earlyBirdStarsPromise : earlyBirdStars,
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    planAdherence: streamLandingCards ? planAdherencePromise : planAdherence,
    latestPayslip,
    leaveEntitlementDays: balance?.entitlementDays ?? null,
    leaveDaysRemaining,
    mrSalesAchievement,
    monthlySalesTrend,
    mrAchievementPeriod,
    mrRankStanding,
    doubleVisitPulse,
    mrFieldKpis,
    kpiMonth,
    kpiMonthOptions: kpiMonths,
    mrPendingExpenseCount,
    ...roleExtras,
    plansAwaitingManagerApproval,
    plansCountAvailable,
    dvFocus,
    cvFolders: streamLandingCards ? cvFoldersPromise : cvFolders,
    repCards,
    roleCards: streamRoleExtras ? roleExtrasPromise : null,
    dvFocusCard: streamDvFocus ? dvFocusPromise : null,
  };
}
