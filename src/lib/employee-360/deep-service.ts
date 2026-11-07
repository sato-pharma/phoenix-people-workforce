// Employee 360 — deep profile: sales, coaching, double-visit history, and the
// before/after IMPACT of coaching sessions and Training-Manager double-visits.
//
// Server-only. Composes on top of the base visit/check-in summary (service.ts)
// and reuses the SAME fetched visit rows so we never scan the CRM twice. All
// per-employee queries are small (one rep's rows), so no rollup fact is needed.
//
// Honesty rules encoded here:
//  - Coaching is one rater (the Training Manager) and sparse — future-dated rows
//    are excluded and counted; "not coached" is a coverage state, never a 0.
//  - Sales lags visits and covers only part of the field — a rep with no sales rows shows
//    "no validated sales", never 0%. How much of the field it covers is computed live
//    (fieldBenchmarks below), never written down.
//  - Impact windows report their sample size so a thin before/after isn't oversold.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getRepContactList } from "@/lib/crm/contact-lists";
import type { CrmListType } from "@/lib/crm/list-types";
import { CRM_DOUBLE_VISIT_TYPE_CODES, isCrmDoubleVisitRow, queryVisitsLimited, visitPartnerHrIds } from "@/lib/crm/reads";
import { addBucketToSplit, emptyVisitCountSplit, visitCountBucket, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { isFieldWorkVisit, REGULAR_TYPE } from "@/lib/crm/visit-types";
import { isUnplannedFieldVisit } from "@/lib/crm/visit-type-meaning";
import { managerDayFigures, type ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import { visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { loadManagerVisitDetails } from "@/lib/phoenix-crm/server/manager-visit-details";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { ownAndEarlierRecordHrIds } from "@/lib/employees/continuous-service";
import {
  phoenixDetailViewer,
  phoenixRowSight,
  phoenixVisitDetail,
  type PhoenixDetailSight,
  type PhoenixVisitDetail,
} from "@/lib/crm/phoenix-visit-detail";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { todayInCairo } from "@/lib/date-only";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { canViewRestrictedProducts, restrictedProductNameSet, stripRestrictedRowsByName } from "@/lib/sales/access-scope";
import { completedReportStatuses } from "@/lib/coaching/analytics";
import { getPmProductCodes, resolvePmSalesFamilies } from "@/lib/employee-360/pm-products";
import {
  buildEmployee360TeamSales,
  loadCanonicalEmployee360SalesRows,
  loadEmployee360SalesWindow,
  maskRestrictedEmployee360Rows,
  selectEmployee360RowsForFamilies,
  unpublishedEmployee360FamilyPeriods,
} from "@/lib/employee-360/sales-canonical";
import {
  CAMPAIGN_TYPE,
  classifyVisit,
  customerKeyOf,
  defaultWindow,
  employee360ReaderSeesPhoenixCheckins,
  fetchCheckinRows,
  fetchVisitRows,
  isProductiveVisit,
  summarizeCheckins,
  summarizeVisits,
  windowSalesEfficiency,
  type Employee360Summary,
  type Employee360Window,
  type VisitRow,
} from "./service";
import { EMPLOYEE_360_BENCHMARKS } from "./benchmarks";
import { loadEmployee360BrickPanel, type Employee360BrickPanel } from "./brick-coverage";
import { canonicalizeLocation, canonicalizeTransport, resolveGovernorate } from "./egypt-locations";
import { isFieldLeaderCategory, resolveEmployee360RoleCategory, type Employee360RoleCategory } from "./roles";

const IMPACT_WINDOW_DAYS = 30;

// ── Sales ──────────────────────────────────────────────────────────────────
/** `hasTarget` false: the month carries sales and no target at all — shown, never graded. */
export type SalesMonthPoint = { month: string; sales: number; target: number; hasTarget: boolean; achievementPct: number | null };
export type SalesProduct = { product: string; family: string | null; sales: number; target: number; achievementPct: number | null };
export type SalesFamily = { family: string; sales: number; target: number; achievementPct: number | null };
export type SalesSummary = {
  hasData: boolean;
  /** Every month's sales, targeted or not. */
  totalSales: number;
  totalTarget: number;
  /** The achievement numerator: sales in the months that carry a target. */
  gradedSales: number;
  /** gradedSales ÷ totalTarget — a month with no target is left out of both halves. */
  achievementPct: number | null;
  latestMonth: string | null;
  monthsCount: number;
  /** Months carrying a target — the divisor of "months hit target". */
  targetedMonthsCount: number;
  /** Months with sales and no target, ascending (`YYYY-MM`). */
  untargetedMonths: string[];
  /**
   * Those months in words ("Mar – Jun 2026") — only when some months carry a target and some do
   * not. With no target anywhere every figure already reads "—", so there is nothing to name.
   */
  untargetedLabel: string | null;
  /**
   * Months with sales whose Monthly Closing is not published yet, ascending (`YYYY-MM`). Never a
   * figure: the section names each one "Not published yet" (owner, 2026-10-27).
   */
  unpublishedMonths: string[];
  /**
   * The seat map did not load for a manager, so his team total cannot be placed. Every figure is
   * withheld and the summary says it could not be read — never a smaller, rep-only number.
   */
  teamUnreadable: boolean;
  monthsHitTarget: number;
  growthPct: number | null;
  salesPerVisit: number | null;
  salesPerCustomer: number | null;
  monthly: SalesMonthPoint[];
  topProducts: SalesProduct[];
  byFamily: SalesFamily[];
  isTeamRollup: boolean; // true when these are a manager's team sales, not own
  teamRepCount: number; // reps contributing (0 when own sales)
  summaryText: string;
};

export type SalesRow = {
  employee_hr_id: string | null;
  line: string | null;
  family: string | null;
  product: string | null;
  month: number | null;
  year: number | null;
  sales_value: number | null;
  target_value: number | null;
};

function achievement(sales: number, target: number): number | null {
  return target > 0 ? (sales / target) * 100 : null;
}

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred ids
// can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError. A manager's teamHrIds (subject + whole org subtree, e.g. an NSM's line)
// can reach hundreds-to-thousands of keys once expanded through hrIdLookupKeys, so any .in() built
// from it must be chunked.
function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The words of a failed page read: `fetchAllRows` throws the database's own error object. */
function pagerErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

// A manager's sales = the roll-up of their whole team (subject + all descendants).
// For a rep, teamHrIds is just [self], so this is their own sales.
//
// Confidential products (LA003/LA004/SS001 — see src/lib/sales/access-scope.ts,
// the single source of truth) are stripped BEFORE any aggregation, same as the
// Sales module: they must never surface in a total, KPI, chart, or product list
// for a non-CEO/Super-Admin viewer.
//
// This is now the BACKSTOP, not the primary mask. Canonical rows carry product_code,
// so maskRestrictedEmployee360Rows strips by code first — exact, and immune to the
// product-name drift this name pass has to tolerate. The name pass still runs after
// it, to catch a product renamed into a restricted name ahead of the master.
// Pure, DB-free filter step — exported so the masking wiring is unit-testable
// without a Supabase round trip (see stripRestrictedRowsByName's own tests in
// tests/sales-restricted-products.test.ts for the underlying strip logic).
export function applyRestrictedProductFilter<T extends SalesRow>(
  rows: T[],
  viewerRole: PhoenixRole,
  restrictedNames: Set<string>,
): T[] {
  if (canViewRestrictedProducts(viewerRole)) return rows;
  return stripRestrictedRowsByName(rows, restrictedNames, (r) => r.product, true);
}

export async function getEmployeeSales(subjectHrId: string, teamHrIds: string[], viewerRole: PhoenixRole): Promise<SalesSummary> {
  // One window load for the whole company, then narrowed in memory (see sales-canonical.ts):
  // published closing months only, each month credited to whoever held the seat then, and a
  // manager's team taken from the seats he held — vacant rep seats included — not from his reps.
  // NOT a re-hired person's earlier record (continuous-service.ts): those sales are another line's
  // products, and the owner ruled them out of the new record's history (2026-11-05).
  const keys = Array.from(new Set(teamHrIds.flatMap((id) => hrIdLookupKeys(id))));
  const team = buildEmployee360TeamSales(await loadEmployee360SalesWindow(), subjectHrId, keys, viewerRole);
  if (team.teamUnreadable) {
    logError("Employee 360 sales seat map is empty for a manager; team total withheld", {
      labels: { event: "employee_360_seat_tree_failed" },
    });
    return teamSalesUnreadable();
  }
  let rows = team.rows;
  // Code-based masking above is exact; the name pass stays as a backstop for a product whose
  // name matches a restricted one but whose code does not (a rename that outran the master).
  if (!canViewRestrictedProducts(viewerRole)) {
    rows = applyRestrictedProductFilter(rows, viewerRole, await restrictedProductNameSet());
  }
  // The subject's OWN aliases must not count as contributing team-mates, or a solo rep whose
  // rows carry an alias of their HR id reads as a one-person "team roll-up".
  const subjectKeys = new Set(hrIdLookupKeys(subjectHrId).map((k) => k.trim().toLowerCase()));
  const contributingReps = new Set(
    rows.map((r) => String(r.employee_hr_id ?? "").trim().toLowerCase()).filter((k) => k && !subjectKeys.has(k)),
  );
  // A vacant seat's month (no rep) is team sales too, though it adds no rep to the head count.
  const isTeamRollup = teamHrIds.length > 1 && (contributingReps.size > 0 || rows.some((r) => !r.employee_hr_id));
  return withUnpublishedMonths(aggregateSalesRows(rows, isTeamRollup, contributingReps.size), team.unpublishedPeriods);
}

/** A manager's sales when the seat map could not be read: no figure at all, and the reason. PURE. */
export function teamSalesUnreadable(): SalesSummary {
  return {
    ...aggregateSalesRows([], true, 0),
    teamUnreadable: true,
    summaryText: "The team's sales could not be read because the sales seat map did not load. No partial total is shown.",
  };
}

/**
 * Name the months still waiting on a published closing (owner, 2026-10-27: "Not published yet",
 * never a figure and never a zero). With nothing published at all, the summary says so instead of
 * "no sales records", which would be false. PURE.
 */
export function withUnpublishedMonths(summary: SalesSummary, unpublishedMonths: readonly string[]): SalesSummary {
  const months = [...new Set(unpublishedMonths)].sort();
  if (months.length === 0) return summary;
  const label = describeSalesMonths(months);
  return {
    ...summary,
    unpublishedMonths: months,
    summaryText: summary.hasData
      ? `${summary.summaryText} ${label}: not published yet.`.trim()
      : `${label}: not published yet. Sales show here once that month's closing is published.`,
  };
}

/**
 * PM / Group PM sales attributed by the PRODUCTS they own (product-manager master),
 * not a team roll-up — a PM has no reports, so the team path returns nothing.
 *
 * Attribution stays at `family` grain — the SKU-agnostic grouping that matches the master's
 * family, resolved from the assigned codes — because that is what a PM actually owns: a whole
 * brand, not a SKU list. (The canonical engine does carry product_code, unlike the legacy table
 * this replaced, so a code-grain variant is now possible; it is not what the PM master models.)
 */
export async function getEmployeeSalesByFamilies(
  families: string[],
  viewerRole: PhoenixRole,
): Promise<SalesSummary> {
  const fams = Array.from(new Set(families.map((f) => String(f).trim()).filter(Boolean)));
  if (fams.length === 0) return aggregateSalesRows([], false, 0);
  // Same single canonical load as the team path — memoized per request, so a profile that
  // resolves a PM does not pay for it twice.
  const [all, window] = await Promise.all([loadCanonicalEmployee360SalesRows(), loadEmployee360SalesWindow()]);
  let rows = maskRestrictedEmployee360Rows(selectEmployee360RowsForFamilies(all, fams), viewerRole);
  if (!canViewRestrictedProducts(viewerRole)) {
    rows = applyRestrictedProductFilter(rows, viewerRole, await restrictedProductNameSet());
  }
  // Published months only, like the team path — and the months still waiting on a closing are
  // NAMED, never silently missing.
  return withUnpublishedMonths(
    aggregateSalesRows(rows, false, 0),
    unpublishedEmployee360FamilyPeriods(window, fams, viewerRole),
  );
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTH_ABBR[Number(month) - 1] ?? month} ${year}`;
}

/**
 * `YYYY-MM` months as words, consecutive months folded into one run. PURE.
 * ["2026-03","2026-04","2026-05","2026-06"] -> "Mar – Jun 2026"; a lone month stays "Sep 2026".
 */
export function describeSalesMonths(periods: readonly string[]): string {
  const sorted = [...new Set(periods)].filter((p) => /^\d{4}-\d{2}$/.test(p)).sort();
  const runs: string[][] = [];
  for (const period of sorted) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (prev) {
      const [y, m] = prev.split("-").map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      if (next === period) {
        run.push(period);
        continue;
      }
    }
    runs.push([period]);
  }
  return runs
    .map((run) => {
      const first = run[0];
      const last = run[run.length - 1];
      if (first === last) return monthLabel(first);
      const sameYear = first.slice(0, 4) === last.slice(0, 4);
      return `${sameYear ? MONTH_ABBR[Number(first.slice(5)) - 1] : monthLabel(first)} – ${monthLabel(last)}`;
    })
    .join(", ");
}

/**
 * Pure aggregation of sales rows into the SalesSummary shape (shared by the team-roll-up and
 * product-based sales paths).
 *
 * THE CLOSING'S RULE, the one the Business Review already follows: inside a month every pound
 * counts, including sales on a product nobody targeted; across months, a month carrying NO target
 * at all is left out of the achievement — out of the numerator as well as the denominator. Every
 * month's sales still show, in the total and in the monthly list. March to June 2026 hold sales and
 * no target anywhere, so before this a long-serving rep's March–June sales were divided by
 * January's, February's, July's and August's targets: Nosiba Salah read 103% while no month that
 * carried a target passed 79%.
 *
 * "No target" is judged on the SUBJECT's own rows (the rep, the manager's roll-up, the PM's
 * brands), so an untargeted rep inside a targeted team month still counts toward the team's month.
 */
export function aggregateSalesRows(rows: SalesRow[], isTeamRollup: boolean, contributingRepCount: number): SalesSummary {
  const monthMap = new Map<string, { sales: number; target: number }>();
  for (const r of rows) {
    if (r.month == null || r.year == null) continue;
    const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
    const m = monthMap.get(key) ?? { sales: 0, target: 0 };
    m.sales += Number(r.sales_value ?? 0);
    m.target += Number(r.target_value ?? 0);
    monthMap.set(key, m);
  }
  const monthHasTarget = (r: SalesRow) => {
    // A row with no month cannot be placed against any month's target, so it is graded as it
    // always was: its own target (usually none) is its whole claim.
    if (r.month == null || r.year == null) return Number(r.target_value ?? 0) > 0;
    return (monthMap.get(`${r.year}-${String(r.month).padStart(2, "0")}`)?.target ?? 0) > 0;
  };

  const productMap = new Map<string, { family: string | null; sales: number; graded: number; target: number }>();
  const familyMap = new Map<string, { sales: number; graded: number; target: number }>();
  let totalSales = 0;
  let gradedSales = 0;
  let totalTarget = 0;
  for (const r of rows) {
    const sales = Number(r.sales_value ?? 0);
    const target = Number(r.target_value ?? 0);
    const graded = monthHasTarget(r) ? sales : 0;
    totalSales += sales;
    gradedSales += graded;
    totalTarget += target;
    const pkey = (r.product ?? "—").trim() || "—";
    const p = productMap.get(pkey) ?? { family: r.family, sales: 0, graded: 0, target: 0 };
    p.sales += sales;
    p.graded += graded;
    p.target += target;
    productMap.set(pkey, p);
    const fkey = (r.family ?? "—").trim() || "—";
    const f = familyMap.get(fkey) ?? { sales: 0, graded: 0, target: 0 };
    f.sales += sales;
    f.graded += graded;
    f.target += target;
    familyMap.set(fkey, f);
  }

  const monthly = Array.from(monthMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, m]) => ({ month, sales: m.sales, target: m.target, hasTarget: m.target > 0, achievementPct: achievement(m.sales, m.target) }));
  const topProducts = Array.from(productMap.entries())
    .map(([product, p]) => ({ product, family: p.family, sales: p.sales, target: p.target, achievementPct: achievement(p.graded, p.target) }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 6);
  const byFamily = Array.from(familyMap.entries())
    .map(([family, f]) => ({ family, sales: f.sales, target: f.target, achievementPct: achievement(f.graded, f.target) }))
    .sort((a, b) => b.sales - a.sales);

  const overallAchv = achievement(gradedSales, totalTarget);
  const targetedMonths = monthly.filter((m) => m.hasTarget);
  const untargetedMonths = monthly.filter((m) => !m.hasTarget).map((m) => m.month);
  const monthsHitTarget = targetedMonths.filter((m) => (m.achievementPct ?? 0) >= 100).length;
  const growthPct = monthly.length > 1 && monthly[0].sales > 0 ? ((monthly[monthly.length - 1].sales - monthly[0].sales) / monthly[0].sales) * 100 : null;
  const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const top = topProducts[0];
  const teamPrefix = isTeamRollup ? `Team roll-up (${contributingRepCount} rep${contributingRepCount === 1 ? "" : "s"}): ` : "";
  const untargetedSales = totalSales - gradedSales;
  const untargetedLabel = untargetedMonths.length > 0 && targetedMonths.length > 0 ? describeSalesMonths(untargetedMonths) : null;
  const gradedPart =
    targetedMonths.length > 0
      ? `${overallAchv == null ? "—" : Math.round(overallAchv)}% of target (${compact(gradedSales)} / ${compact(totalTarget)}) across ${targetedMonths.length} month${targetedMonths.length === 1 ? "" : "s"} with a target, ` +
        `hitting target in ${monthsHitTarget}. `
      : `No month here carries a target, so nothing is graded. `;
  const untargetedPart = untargetedLabel
    ? `${untargetedLabel} ${untargetedMonths.length === 1 ? "has" : "have"} no target: ${compact(untargetedSales)} of sales shown, not graded. `
    : "";
  const summaryText =
    rows.length === 0
      ? "No validated sales records for this employee yet."
      : teamPrefix +
        `${compact(totalSales)} of sales across ${monthly.length} month${monthly.length === 1 ? "" : "s"}. ` +
        gradedPart +
        untargetedPart +
        (top && top.achievementPct != null ? `Led by ${top.product} (${Math.round(top.achievementPct)}% of target). ` : top ? `Led by ${top.product}. ` : "") +
        (growthPct != null ? `${growthPct >= 0 ? "+" : ""}${Math.round(growthPct)}% vs the first month.` : "");

  return {
    hasData: rows.length > 0,
    totalSales,
    totalTarget,
    gradedSales,
    achievementPct: overallAchv,
    latestMonth: monthly.length ? monthly[monthly.length - 1].month : null,
    monthsCount: monthly.length,
    targetedMonthsCount: targetedMonths.length,
    untargetedMonths,
    untargetedLabel,
    unpublishedMonths: [],
    teamUnreadable: false,
    monthsHitTarget,
    growthPct,
    salesPerVisit: null,
    salesPerCustomer: null,
    monthly,
    topProducts,
    byFamily,
    isTeamRollup,
    teamRepCount: contributingRepCount,
    summaryText,
  };
}

// ── Coaching ───────────────────────────────────────────────────────────────
export type CoachingReportPoint = {
  date: string;
  finalScorePercent: number | null;
  zone: string | null;
  actualScore: number | null;
  maxScore: number | null;
  coachName: string | null;
  areaOfDevelopment: string | null;
  strengthPoints: string | null;
};
export type CoachingCompetency = { key: string; label: string; category: string; avgScore: number; avgPercent: number; count: number };
export type CoachingCategory = { category: string; avgPercent: number };
export type CoachingSummary = {
  hasData: boolean;
  reportCount: number;
  futureDatedExcluded: number;
  singleRater: boolean;
  coachNames: string[];
  latest: { date: string; finalScorePercent: number | null; zone: string | null } | null;
  first: { date: string; finalScorePercent: number | null } | null;
  improvement: number | null;
  avgScore: number | null;
  reports: CoachingReportPoint[];
  categories: CoachingCategory[];
  weakestCompetencies: CoachingCompetency[];
};

type CoachingReportRow = {
  id: string;
  coaching_date: string | null;
  final_score_percent: number | null;
  performance_zone: string | null;
  actual_score: number | null;
  max_score: number | null;
  coach_hr_id: string | null;
  area_of_development: string | null;
  strength_points: string | null;
};
type CoachingItemRow = {
  report_id: string;
  parameter_category: string | null;
  score_item_key: string | null;
  score_item_label: string | null;
  score: number | null;
};

function humanizeCategory(value: string | null): string {
  if (!value) return "Other";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A rep's coaching over the profile's window, completed reports only — the coaching module's own
 * rule (`completedReportStatuses`), so this count equals his coach's "Coaching delivered" for the
 * same dates. Until 2026-10-27 it read all time, drafts included, and stopped at 500 rows before
 * sorting, so a long history lost its newest reports.
 */
async function getEmployeeCoaching(
  hrId: string,
  nameByHrId: Map<string, string>,
  window: Pick<Employee360Window, "from" | "to">,
): Promise<CoachingSummary> {
  const supabase = getSupabaseAdmin();
  let allRows: CoachingReportRow[];
  try {
    allRows = await fetchAllRows<CoachingReportRow>(
      () =>
        supabase
          .from("coaching_reports")
          .select("id,coaching_date,final_score_percent,performance_zone,actual_score,max_score,coach_hr_id,area_of_development,strength_points")
          // Her coaching under an earlier record before a re-hire is hers too (continuous-service.ts).
          .in("medical_rep_hr_id", ownAndEarlierRecordHrIds(hrId).flatMap(hrIdLookupKeys))
          .in("status", [...completedReportStatuses])
          .gte("coaching_date", window.from),
      "id",
    );
  } catch (error) {
    throw new Error(`Employee 360 coaching: ${error instanceof Error ? error.message : String(error)}`);
  }

  const today = todayInCairo();
  const last = window.to < today ? window.to : today;
  const rows = allRows.filter((r) => r.coaching_date && r.coaching_date <= last);
  const futureDatedExcluded = allRows.filter((r) => r.coaching_date && r.coaching_date > today).length;
  rows.sort((a, b) => String(a.coaching_date).localeCompare(String(b.coaching_date)));

  if (rows.length === 0) {
    return {
      hasData: false,
      reportCount: 0,
      futureDatedExcluded,
      singleRater: false,
      coachNames: [],
      latest: null,
      first: null,
      improvement: null,
      avgScore: null,
      reports: [],
      categories: [],
      weakestCompetencies: [],
    };
  }

  const coachSet = new Set<string>();
  const reports: CoachingReportPoint[] = rows.map((r) => {
    const coachKey = String(r.coach_hr_id ?? "").trim().toLowerCase();
    const coachName = nameByHrId.get(coachKey) ?? r.coach_hr_id ?? null;
    if (r.coach_hr_id) coachSet.add(coachKey);
    return {
      date: String(r.coaching_date),
      finalScorePercent: r.final_score_percent != null ? Number(r.final_score_percent) : null,
      zone: r.performance_zone,
      actualScore: r.actual_score != null ? Number(r.actual_score) : null,
      maxScore: r.max_score != null ? Number(r.max_score) : null,
      coachName,
      areaOfDevelopment: r.area_of_development,
      strengthPoints: r.strength_points,
    };
  });

  // competency + category aggregation across all of this rep's reports
  const reportIds = rows.map((r) => r.id);
  const items: CoachingItemRow[] = [];
  for (const batch of chunk(reportIds)) {
    // A hundred reports hold about two thousand scored items, so one request cannot be trusted to
    // return them all: walked page by page, never cut at a fixed number.
    try {
      items.push(
        ...(await fetchAllRows<CoachingItemRow>(
          () =>
            supabase
              .from("coaching_score_items")
              .select("report_id,parameter_category,score_item_key,score_item_label,score")
              .in("report_id", batch),
          "id",
        )),
      );
    } catch (error) {
      throw new Error(`Employee 360 coaching items: ${pagerErrorMessage(error)}`);
    }
  }

  const compMap = new Map<string, { label: string; category: string; sum: number; count: number }>();
  const catMap = new Map<string, { sum: number; count: number }>();
  for (const it of items) {
    if (it.score == null || !it.score_item_key) continue;
    const key = it.score_item_key;
    const category = humanizeCategory(it.parameter_category);
    const c = compMap.get(key) ?? { label: it.score_item_label ?? key, category, sum: 0, count: 0 };
    c.sum += Number(it.score);
    c.count += 1;
    compMap.set(key, c);
    const cat = catMap.get(category) ?? { sum: 0, count: 0 };
    cat.sum += Number(it.score);
    cat.count += 1;
    catMap.set(category, cat);
  }

  const weakestCompetencies: CoachingCompetency[] = Array.from(compMap.entries())
    .map(([key, c]) => ({ key, label: c.label, category: c.category, avgScore: c.sum / c.count, avgPercent: (c.sum / c.count / 5) * 100, count: c.count }))
    .sort((a, b) => a.avgScore - b.avgScore)
    .slice(0, 8);
  const categories: CoachingCategory[] = Array.from(catMap.entries())
    .map(([category, c]) => ({ category, avgPercent: (c.sum / c.count / 5) * 100 }))
    .sort((a, b) => a.avgPercent - b.avgPercent);

  const scored = reports.filter((r) => r.finalScorePercent != null);
  const first = reports[0];
  const latest = reports[reports.length - 1];
  const avgScore = scored.length ? scored.reduce((s, r) => s + (r.finalScorePercent as number), 0) / scored.length : null;
  const improvement =
    first.finalScorePercent != null && latest.finalScorePercent != null && reports.length > 1
      ? latest.finalScorePercent - first.finalScorePercent
      : null;

  return {
    hasData: true,
    reportCount: reports.length,
    futureDatedExcluded,
    singleRater: coachSet.size <= 1,
    coachNames: Array.from(coachSet).map((k) => nameByHrId.get(k) ?? k),
    latest: { date: latest.date, finalScorePercent: latest.finalScorePercent, zone: latest.zone },
    first: { date: first.date, finalScorePercent: first.finalScorePercent },
    improvement,
    avgScore,
    reports,
    categories,
    weakestCompetencies,
  };
}

// ── Double-visit history ─────────────────────────────────────────────────────
export type DoubleVisitEvent = {
  date: string;
  doubleHrId: string;
  doubleName: string | null;
  /** A chain visit's SECOND manager (Phoenix-only — the vendor had one partner column). The visit is ONE
   * visit the rep received (`totalReceived` counts it once) and it is in BOTH managers' records, so he is
   * in `byVisitor` and `distinctVisitors` exactly as the first manager is (owner, 2026-10-08). */
  double2Name: string | null;
  /**
   * Everyone else on the visit past the two slots — a Phoenix visit carries any mix of companions (owner,
   * 2026-10-27: "Everything is applicable"), and the third and fourth stand only in `companion_hr_ids`.
   * Null where the name is not on record. Empty on a vendor row and on a visit of one or two.
   */
  otherNames: (string | null)[];
  isTrainingManager: boolean;
  kind: "Regular" | "Unplanned" | "Other";
  ampm: string | null;
  customerName: string | null;
  /** The Phoenix field set, shaped to THIS reader's tier. Null on a vendor row. */
  phoenix: PhoenixVisitDetail | null;
};
export type DoubleVisitor = { hrId: string; name: string | null; count: number; isTrainingManager: boolean };
export type DoubleVisitHistory = {
  totalReceived: number;
  /** The distinct days those double visits were made on (owner, 2026-10-27). */
  daysReceived: number;
  tmCount: number;
  distinctVisitors: number;
  byVisitor: DoubleVisitor[];
  /** The visitors past the top ten, so the chips account for every visitor (2026-10-27). */
  otherVisitors: { people: number; visits: number };
  events: DoubleVisitEvent[];
};

/**
 * The days a Training Manager was on a double visit the rep received — the dates the training-impact
 * window pools around. Any companion counts, not only the two slots: the Training Manager can be the
 * third or fourth on a chain (owner, 2026-10-27). `tmIds` is lower-cased.
 */
export function trainingManagerVisitDates(visits: readonly VisitRow[], tmIds: ReadonlySet<string>): string[] {
  return visits
    .filter(
      (v) =>
        isCrmDoubleVisitRow(v) &&
        v.double_hr_id &&
        v.visit_date &&
        visitPartnerHrIds(v).some((id) => tmIds.has(id.toLowerCase())),
    )
    .map((v) => v.visit_date as string);
}

export function buildDoubleVisitHistory(
  visits: VisitRow[],
  tmIds: Set<string>,
  nameByHrId: Map<string, string>,
  sight: PhoenixDetailSight,
): DoubleVisitHistory {
  const events: DoubleVisitEvent[] = [];
  const byVisitor = new Map<string, { name: string | null; count: number; isTm: boolean }>();
  for (const v of visits) {
    // Only real double visits: a genuine partner (double_crm_id) on a fieldwork
    // type {0,-8}. A partner riding along on a Meeting/Vacation/Training row is
    // NOT a double visit (matches the canonical crm/reads predicate). A partner with no
    // resolved double_hr_id still counts (2026-10-27: 32 such visits this year were missing here
    // while the visits section's "doubles received" counted them) — keyed by his CRM id instead.
    if (!isCrmDoubleVisitRow(v) || !v.visit_date) continue;
    const resolvedHrId = String(v.double_hr_id ?? "").trim();
    const key = resolvedHrId ? resolvedHrId.toLowerCase() : `crm:${v.double_crm_id ?? "unknown"}`;
    const key2 = v.double2_hr_id ? String(v.double2_hr_id).trim().toLowerCase() : null; // gitleaks:allow — a map key, not a credential
    // Everyone on the visit: the two slots and every companion past them (2026-10-27), each once.
    const partnerKeys = visitPartnerHrIds(v).map((id) => id.toLowerCase());
    const otherKeys = partnerKeys.filter((k) => k !== key && k !== key2);
    // A Training Manager ANYWHERE on the visit makes it a training double visit the rep received.
    const isTm = partnerKeys.some((k) => tmIds.has(k));
    const name = nameByHrId.get(key) ?? v.double_name ?? null;
    const visitBucket = classifyVisit(v.visit_type, v.comment, v.visit_type_description).bucket;
    // "Campaign" is UNPLANNED now (owner, 6 Nov 2026): Phoenix's own flag, or a campaign visit (−8) on an archive day.
    const kind = visitBucket === "regular" || visitBucket === "campaign" ? (isUnplannedFieldVisit(v) ? "Unplanned" : "Regular") : "Other";
    events.push({
      date: v.visit_date,
      doubleHrId: resolvedHrId,
      doubleName: name,
      double2Name: (key2 ? nameByHrId.get(key2) : null) ?? (v.double2_name?.trim() || null),
      otherNames: otherKeys.map((k) => nameByHrId.get(k) ?? null),
      isTrainingManager: isTm,
      kind,
      ampm: v.ampm,
      customerName: v.contact_name ?? v.customer_name ?? null,
      phoenix: v.visit_kind ? phoenixVisitDetail(v, sight) : null,
    });
    // Each manager on the visit is credited once — a chain visit's second manager exactly like the first.
    const credit = (visitorKey: string, visitorName: string | null) => {
      const agg = byVisitor.get(visitorKey) ?? { name: visitorName, count: 0, isTm: tmIds.has(visitorKey) };
      agg.count += 1;
      byVisitor.set(visitorKey, agg);
    };
    credit(key, name);
    if (key2 && key2 !== key) credit(key2, nameByHrId.get(key2) || v.double2_name?.trim() || null);
    for (const other of otherKeys) credit(other, nameByHrId.get(other) ?? null);
  }
  events.sort((a, b) => b.date.localeCompare(a.date));
  const visitorList: DoubleVisitor[] = Array.from(byVisitor.entries())
    .map(([hrId, a]) => ({ hrId, name: a.name, count: a.count, isTrainingManager: a.isTm }))
    .sort((a, b) => b.count - a.count);

  return {
    totalReceived: events.length,
    daysReceived: new Set(events.map((e) => e.date)).size,
    tmCount: events.filter((e) => e.isTrainingManager).length,
    distinctVisitors: visitorList.length,
    byVisitor: visitorList.slice(0, 10),
    otherVisitors: { people: Math.max(0, visitorList.length - 10), visits: visitorList.slice(10).reduce((n, v) => n + v.count, 0) },
    events: events.slice(0, 40),
  };
}

// ── Before/after impact ──────────────────────────────────────────────────────
/** `distinctCustomers` is null when no span held a visit — "no data", never a measured zero. */
export type ImpactMetrics = { visitsPerActiveDay: number | null; campaignShare: number | null; distinctCustomers: number | null; sampleDays: number; sampleVisits: number };
export type ImpactSet = { eventCount: number; windowDays: number; before: ImpactMetrics; after: ImpactMetrics };
export type InterventionImpact = { windowDays: number; coaching: ImpactSet; trainingDv: ImpactSet };

type ProductiveRow = { date: string; isCampaign: boolean; customer: string };

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function metricsInRange(rows: ProductiveRow[], start: string, end: string): ImpactMetrics {
  const inRange = rows.filter((r) => r.date >= start && r.date <= end);
  const days = new Set(inRange.map((r) => r.date));
  const customers = new Set(inRange.map((r) => r.customer).filter(Boolean));
  const campaign = inRange.filter((r) => r.isCampaign).length;
  return {
    visitsPerActiveDay: days.size > 0 ? inRange.length / days.size : null,
    campaignShare: inRange.length > 0 ? campaign / inRange.length : null,
    distinctCustomers: days.size > 0 ? customers.size : null,
    sampleDays: days.size,
    sampleVisits: inRange.length,
  };
}

function roundOrNull(value: number | null): number | null {
  return value == null ? null : Math.round(value);
}

function meanNullable(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null);
  return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}

/**
 * Before/after each event. PURE. `observed` is the stretch the visit rows cover: an event counts only
 * when both of its spans sit wholly inside it (2026-10-27 — an event in the window's first month had a
 * "before" the read never fetched, and one in the last month an "after" still to come, and both were
 * averaged in as zero customers).
 */
export function poolImpact(
  rows: ProductiveRow[],
  eventDates: string[],
  windowDays: number,
  observed: { from: string; to: string },
): ImpactSet {
  const dates = Array.from(new Set(eventDates))
    .filter((d) => addDays(d, -windowDays) >= observed.from && addDays(d, windowDays) <= observed.to)
    .sort();
  const beforeList: ImpactMetrics[] = [];
  const afterList: ImpactMetrics[] = [];
  for (const d of dates) {
    beforeList.push(metricsInRange(rows, addDays(d, -windowDays), addDays(d, -1)));
    afterList.push(metricsInRange(rows, addDays(d, 1), addDays(d, windowDays)));
  }
  const fold = (list: ImpactMetrics[]): ImpactMetrics => ({
    visitsPerActiveDay: meanNullable(list.map((m) => m.visitsPerActiveDay)),
    campaignShare: meanNullable(list.map((m) => m.campaignShare)),
    distinctCustomers: roundOrNull(meanNullable(list.map((m) => m.distinctCustomers))),
    sampleDays: list.reduce((s, m) => s + m.sampleDays, 0),
    sampleVisits: list.reduce((s, m) => s + m.sampleVisits, 0),
  });
  return { eventCount: dates.length, windowDays, before: fold(beforeList), after: fold(afterList) };
}

// ── Expenses & Outstation ────────────────────────────────────────────────────
// Real expense history lives in outstation_expenses. Outstation requests submitted
// in Phoenix (outstation_expense_requests) are folded in beside it when present:
// claimed and expected amounts, and requests with an eligibility or territory issue.
// No variance and no fraud signal is computed for them any more.
export type ExpenseCategory = { key: string; label: string; amount: number; pct: number };
export type NamedCost = { name: string; cost: number; trips: number };
export type ExpenseMonth = { month: string; cost: number; trips: number };
export type ExpenseTypeBucket = { type: "Travel" | "Meeting" | "Other"; trips: number; cost: number };
export type ExpenseTrip = { date: string; destination: string; type: "Travel" | "Meeting" | "Other"; total: number; transport: string; km: number | null };
export type ExpenseSummary = {
  hasData: boolean;
  tripCount: number;
  totalCost: number;
  costPerTrip: number | null;
  totalKm: number;
  costPerKm: number | null;
  costPerVisit: number | null; // expense ÷ productive visits (cross-domain, set by orchestrator)
  costPerTripVisit: number | null; // expense ÷ AM+PM visits logged on trips
  windowSalesValue: number | null; // the sales of `expenseVsSalesMonths`, the ratio's denominator
  expenseToSalesPct: number | null; // expense as % of the sales of the same months
  /** The months Expenses vs sales covers: the sales months the claims also reach. Null when none. */
  expenseVsSalesMonths: { from: string; to: string } | null;
  /** The last claim month when the claims stop before the period ends — Cost / visit stops there too. */
  claimsThrough: string | null;
  noDestinationTrips: number; // TRAVEL trips with no recorded destination (meetings excluded — they need none)
  unresolvedTrips: ExpenseTrip[]; // placeless travel trips, quarantined out of the analytics until resolved
  meetingCount: number;
  byType: ExpenseTypeBucket[];
  categories: ExpenseCategory[];
  byDestination: NamedCost[];
  monthly: ExpenseMonth[];
  topTrips: ExpenseTrip[];
  transportMix: NamedCost[];
  approvedCount: number;
  approvedCost: number;
  rejectedCount: number;
  pendingCount: number;
  amWorkload: number;
  /** THE AM · PM · PHARMACIES GOLDEN RULE: pharmacy visits logged on trips, never inside AM/PM.
   * Null when no trip in the window counted them apart (every trip predates the 2026-09-21 split). */
  pharmacyWorkload: number | null;
  /** Trips whose pharmacy visits still sit inside AM/PM (stamped before the split, typed by hand,
   * or imported from Excel) — so a reader knows the three figures do not cover them. */
  pharmacyUncountedTrips: number;
  pmWorkload: number;
  summaryText: string;
};
export type OutstationSummary = {
  hasData: boolean;
  /** Rejected requests: counted here, and left out of every other figure. */
  rejectedCount: number;
  tripCount: number;
  claimedTotal: number;
  expectedTotal: number;
  flaggedCount: number;
};
/** `unavailable`: the expense read failed — the section says so, and the rest of the profile still renders. */
export type EmployeeExpenses = { payroll: ExpenseSummary; outstation: OutstationSummary; unavailable?: boolean };

export type PayrollExpenseRow = {
  expense_date: string | null;
  request_type: string | null;
  to_location: string | null;
  location: string | null;
  from_location: string | null;
  description: string | null;
  transportation_type: string | null;
  travel_cost: number | null;
  meeting_amount: number | null;
  allowance: number | null;
  other_amount: number | null;
  total: number | null;
  /** What HR approved when it changed the claim; null means the claim stands. */
  approved_amount: number | null;
  km: number | null;
  status: string | null;
  hr_approved: boolean | null;
  am_workload: number | null;
  pharmacy_workload: number | null;
  pm_workload: number | null;
};
export type OutstationRow = {
  status?: string | null;
  claimed_total_amount: number | null;
  expected_total_amount: number | null;
  eligibility_status: string | null;
  territory_validation_status: string | null;
};

const compactMoney = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

// request_type in outstation_expenses is one of: Traveling, Outstation, Meeting, Other.
// Traveling + Outstation are both field travel (km + travel_cost); Meeting is a
// meeting (meeting_amount, no destination); Other is misc.
function classifyExpenseType(raw: string | null): "Travel" | "Meeting" | "Other" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.includes("meeting") || s.includes("اجتماع") || s.includes("ميتنج")) return "Meeting";
  if (s.includes("travel") || s.includes("outstation") || s.includes("trip") || s.includes("سفر")) return "Travel";
  return "Other";
}

// Expense analysis is a MANAGER view (DM / RM / NSM / TM / PM / GPM) — Medical
// Reps never see it (see showExpenses in the [hrId] page). Returned instead of
// querying outstation_expenses at all, so a Medical Rep's profile never depends on
// that table's availability.
function emptyEmployeeExpenses(): EmployeeExpenses {
  return {
    payroll: {
      hasData: false,
      tripCount: 0,
      totalCost: 0,
      costPerTrip: null,
      totalKm: 0,
      costPerKm: null,
      costPerVisit: null,
      costPerTripVisit: null,
      windowSalesValue: null,
      expenseToSalesPct: null,
      expenseVsSalesMonths: null,
      claimsThrough: null,
      noDestinationTrips: 0,
      unresolvedTrips: [],
      meetingCount: 0,
      byType: [],
      categories: [],
      byDestination: [],
      monthly: [],
      topTrips: [],
      transportMix: [],
      approvedCount: 0,
      approvedCost: 0,
      rejectedCount: 0,
      pendingCount: 0,
      amWorkload: 0,
      pharmacyWorkload: null,
      pharmacyUncountedTrips: 0,
      pmWorkload: 0,
      summaryText: "No expense or outstation records for this employee in this period.",
    },
    outstation: {
      hasData: false,
      rejectedCount: 0,
      tripCount: 0,
      claimedTotal: 0,
      expectedTotal: 0,
      flaggedCount: 0,
    },
  };
}

async function getEmployeeExpenses(hrId: string, window: Employee360Window): Promise<EmployeeExpenses> {
  try {
    return await readEmployeeExpenses(hrId, window);
  } catch (error) {
    // A failed expense read used to throw through the whole profile and blank every section (2026-10-27).
    logError("Employee 360 expenses read failed", { error, labels: { event: "employee_360_expenses_failed" } });
    return { ...emptyEmployeeExpenses(), unavailable: true };
  }
}

/**
 * PURE. The note a total needs when the claims stop before the period ends — the payroll import lags, and a
 * total that silently stops at August reads as the whole period (2026-10-27). Null when nothing is missing.
 */
export function expenseRecordedUntilNote(monthly: readonly { month: string }[], windowTo: string): string | null {
  const last = monthly.length ? monthly[monthly.length - 1].month : null;
  if (!last || last >= windowTo.slice(0, 7)) return null;
  return `No claim is recorded after ${monthLabel(last)}, so the totals cover the period up to then.`;
}

/**
 * PURE. Cost / visit and Expenses vs sales over the months the claims reach. The payroll import lags, so the
 * claims can stop in August while the visits and the sales run on to October — dividing one by the other then
 * reads far too low (Dina Hamdy, 2026-10-27). Both ratios stop at the last claim month, the same boundary
 * `expenseRecordedUntilNote` names. `visitMonthly` is the visit summary's own, so the visits are the ones
 * "Productive visits" counts.
 */
export function expenseEfficiencyOf(input: {
  totalCost: number;
  expenseMonthly: readonly { month: string; cost: number }[];
  visitMonthly: readonly { month: string; regular: number; campaign: number }[];
  salesMonthly: readonly { month: string; sales: number }[];
  /** The sales months inside the period (`windowSalesEfficiency`); null when there are none. */
  salesMonths: { from: string; to: string } | null;
  windowTo: string;
}): {
  costPerVisit: number | null;
  claimsThrough: string | null;
  expenseToSalesPct: number | null;
  matchedSalesValue: number | null;
  matchedMonths: { from: string; to: string } | null;
} {
  const last = input.expenseMonthly.reduce<string | null>((max, m) => (max === null || m.month > max ? m.month : max), null);
  if (!last) return { costPerVisit: null, claimsThrough: null, expenseToSalesPct: null, matchedSalesValue: null, matchedMonths: null };
  const visits = input.visitMonthly.filter((m) => m.month <= last).reduce((sum, m) => sum + m.regular + m.campaign, 0);
  const claimsThrough = last < input.windowTo.slice(0, 7) ? last : null;
  let matchedMonths: { from: string; to: string } | null = null;
  let matchedSalesValue: number | null = null;
  let expenseToSalesPct: number | null = null;
  if (input.salesMonths) {
    const from = input.salesMonths.from;
    const to = input.salesMonths.to < last ? input.salesMonths.to : last;
    const inSpan = (month: string) => month >= from && month <= to;
    const sales = from <= to ? input.salesMonthly.filter((m) => inSpan(m.month)).reduce((sum, m) => sum + m.sales, 0) : 0;
    if (sales > 0) {
      const cost = input.expenseMonthly.filter((m) => inSpan(m.month)).reduce((sum, m) => sum + m.cost, 0);
      matchedMonths = { from, to };
      matchedSalesValue = sales;
      expenseToSalesPct = (cost / sales) * 100;
    }
  }
  return {
    costPerVisit: visits > 0 ? input.totalCost / visits : null,
    claimsThrough,
    expenseToSalesPct,
    matchedSalesValue,
    matchedMonths,
  };
}

async function readEmployeeExpenses(hrId: string, window: Employee360Window): Promise<EmployeeExpenses> {
  const supabase = getSupabaseAdmin();
  const keys = hrIdLookupKeys(hrId);

  // Both are money the profile prints (what the trips pay, what was claimed), so neither read may stop
  // at a fixed number of rows: each is walked page by page and a failed page is the read's failure.
  const [rows, outRows] = await Promise.all([
    fetchAllRows<PayrollExpenseRow>(
      () =>
        supabase
          .from("outstation_expenses")
          .select("expense_date,request_type,to_location,location,from_location,description,transportation_type,travel_cost,meeting_amount,allowance,other_amount,total,approved_amount,km,status,hr_approved,am_workload,pharmacy_workload,pm_workload")
          .in("hr_id", keys)
          .gte("expense_date", window.from)
          .lte("expense_date", window.to),
      "id",
    ).catch((error: unknown): never => {
      throw new Error(`Employee 360 expenses: ${pagerErrorMessage(error)}`);
    }),
    fetchAllRows<OutstationRow>(
      () =>
        supabase
          .from("outstation_expense_requests")
          .select("status,claimed_total_amount,expected_total_amount,eligibility_status,territory_validation_status")
          .in("employee_hr_id", keys)
          .gte("trip_start_date", window.from)
          .lte("trip_start_date", `${window.to} 23:59:59+00`),
      "id",
    ).catch((error: unknown): never => {
      throw new Error(`Employee 360 outstation: ${pagerErrorMessage(error)}`);
    }),
  ]);

  const payroll = summarizePayrollExpenseRows(rows);
  const recordedUntil = payroll.hasData ? expenseRecordedUntilNote(payroll.monthly, window.to) : null;
  return {
    payroll: recordedUntil ? { ...payroll, summaryText: `${payroll.summaryText} ${recordedUntil}` } : payroll,
    outstation: summarizeOutstationRequests(outRows),
  };
}

/**
 * The payroll-expense summary, from the employee's `outstation_expenses` rows.
 *
 * A trip is worth what it PAYS, never what was claimed: `payableExpenseAmount` (the one rule payroll
 * uses) takes HR's `approved_amount` when HR changed the claim. A REJECTED trip pays nothing and is
 * left out of every cost, count and breakdown here; it is only counted, in `rejectedCount`. Which
 * queue a trip sits in comes from `expenseApprovalState`, the same decision the approvals screen uses.
 *
 * The four cost components always add up to the claim, so when HR cut a claim they are scaled by
 * the same share; the category split then adds up to the total it sits under.
 */
export function summarizePayrollExpenseRows(rows: readonly PayrollExpenseRow[]): ExpenseSummary {
  let totalCost = 0;
  let travel = 0;
  let allowance = 0;
  let meeting = 0;
  let other = 0;
  let totalKm = 0;
  let approvedCount = 0;
  let approvedCost = 0;
  let rejectedCount = 0;
  let pendingCount = 0;
  let amWorkload = 0;
  let pharmacyWorkload: number | null = null;
  let pharmacyUncountedTrips = 0;
  let pmWorkload = 0;
  let noDestinationCount = 0;
  const destMap = new Map<string, { cost: number; trips: number }>();
  const monthMap = new Map<string, { cost: number; trips: number }>();
  const transportMap = new Map<string, { cost: number; trips: number }>();
  const typeMap = new Map<"Travel" | "Meeting" | "Other", { trips: number; cost: number }>();
  const trips: ExpenseTrip[] = [];
  const unresolved: ExpenseTrip[] = [];

  for (const r of rows) {
    const state = expenseApprovalState({ hrApproved: r.hr_approved, status: r.status });
    if (state === "rejected") {
      rejectedCount += 1;
      continue;
    }
    const claimed = Number(r.total ?? 0);
    const t = payableExpenseAmount(r.approved_amount, r.total);
    const share = Number.isFinite(claimed) && claimed > 0 ? t / claimed : 1;
    totalCost += t;
    travel += Number(r.travel_cost ?? 0) * share;
    allowance += Number(r.allowance ?? 0) * share;
    meeting += Number(r.meeting_amount ?? 0) * share;
    other += Number(r.other_amount ?? 0) * share;
    totalKm += Number(r.km ?? 0);
    amWorkload += Number(r.am_workload ?? 0);
    // NULL is "not counted separately", never a zero: that trip's pharmacies sit inside AM/PM.
    if (r.pharmacy_workload === null || r.pharmacy_workload === undefined) pharmacyUncountedTrips += 1;
    else pharmacyWorkload = (pharmacyWorkload ?? 0) + Number(r.pharmacy_workload);
    pmWorkload += Number(r.pm_workload ?? 0);
    if (state === "approved") {
      approvedCount += 1;
      approvedCost += t;
    } else {
      pendingCount += 1;
    }
    // Classify the expense. Meetings are not trips and have no destination by
    // nature — they are counted as meetings, never as "missing destination".
    const etype = classifyExpenseType(r.request_type);
    const tb = typeMap.get(etype) ?? { trips: 0, cost: 0 };
    tb.trips += 1;
    tb.cost += t;
    typeMap.set(etype, tb);

    // Destination applies only to travel/other. Use RECORDED data ONLY — to_location,
    // then location, then a confident governorate match in the description. NEVER
    // from_location (the employee's home/origin) and NEVER an inferred/guessed place.
    // A travel trip whose destination was never recorded is quarantined as UNRESOLVED:
    // it is kept out of the destination breakdown and the top-trips list until the
    // source data is actually fixed.
    let dest: string | null = null;
    let unresolvedTrip = false;
    if (etype !== "Meeting") {
      const rawDest = [r.to_location, r.location].map((v) => (v ?? "").trim()).find((v) => v.length > 0);
      dest = rawDest ? canonicalizeLocation(rawDest) : resolveGovernorate(r.description);
      if (dest) {
        const d = destMap.get(dest) ?? { cost: 0, trips: 0 };
        d.cost += t;
        d.trips += 1;
        destMap.set(dest, d);
      } else {
        noDestinationCount += 1;
        unresolvedTrip = true;
      }
    }
    if (r.expense_date) {
      const m = r.expense_date.slice(0, 7);
      const mm = monthMap.get(m) ?? { cost: 0, trips: 0 };
      mm.cost += t;
      mm.trips += 1;
      monthMap.set(m, mm);
    }
    const transport = canonicalizeTransport(r.transportation_type);
    if (transport) {
      const tm = transportMap.get(transport) ?? { cost: 0, trips: 0 };
      tm.cost += t;
      tm.trips += 1;
      transportMap.set(transport, tm);
    }
    const trip: ExpenseTrip = { date: r.expense_date ?? "—", destination: dest ?? "", type: etype, total: t, transport: transport ?? "", km: r.km != null ? Number(r.km) : null };
    // Quarantine placeless travel trips into the Unresolved list; everything else
    // (resolved trips + meetings, which legitimately have no destination) feeds the
    // normal top-trips view.
    if (unresolvedTrip) unresolved.push(trip);
    else trips.push(trip);
  }

  // A rejected trip pays nothing, so it is not part of this period's spend.
  const tripCount = rows.length - rejectedCount;
  const catRaw = [
    { key: "travel", label: "Travel / transport", amount: travel },
    { key: "allowance", label: "Allowance", amount: allowance },
    { key: "meeting", label: "Meeting", amount: meeting },
    { key: "other", label: "Other", amount: other },
  ];
  const catTotal = catRaw.reduce((s, c) => s + c.amount, 0) || 1;
  const categories: ExpenseCategory[] = catRaw
    .filter((c) => c.amount > 0)
    .map((c) => ({ ...c, pct: c.amount / catTotal }))
    .sort((a, b) => b.amount - a.amount);
  const byDestination: NamedCost[] = Array.from(destMap.entries())
    .map(([name, v]) => ({ name, cost: v.cost, trips: v.trips }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 8);
  const monthly: ExpenseMonth[] = Array.from(monthMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, cost: v.cost, trips: v.trips }));
  const topTrips = trips.sort((a, b) => b.total - a.total).slice(0, 6);
  const transportMix: NamedCost[] = Array.from(transportMap.entries())
    .map(([name, v]) => ({ name, cost: v.cost, trips: v.trips }))
    .sort((a, b) => b.cost - a.cost);
  const byType: ExpenseTypeBucket[] = (["Travel", "Meeting", "Other"] as const)
    .map((type) => ({ type, ...(typeMap.get(type) ?? { trips: 0, cost: 0 }) }))
    .filter((b) => b.trips > 0);
  const meetingCount = typeMap.get("Meeting")?.trips ?? 0;

  const topCat = categories[0];
  const topDest = byDestination[0];
  const typeBreakdown = byType.map((b) => `${b.trips} ${b.type.toLowerCase()}`).join(", ");
  const rejectedNote = rejectedCount > 0 ? ` ${rejectedCount} rejected and left out.` : "";
  const summaryText =
    tripCount === 0
      ? rejectedCount > 0
        ? `No payable expenses in this period. ${rejectedCount} rejected.`
        : "No expense or outstation records for this employee in this period."
      : `${tripCount} expense${tripCount === 1 ? "" : "s"} (${typeBreakdown}) paying ${compactMoney(totalCost)}. ` +
        (topCat ? `Biggest bucket: ${topCat.label.toLowerCase()} ${compactMoney(topCat.amount)} (${Math.round(topCat.pct * 100)}%). ` : "") +
        (topDest ? `Top destination ${topDest.name} (${topDest.trips} trips, ${compactMoney(topDest.cost)}). ` : "") +
        `${approvedCount} of ${tripCount} approved.` +
        rejectedNote;

  return {
    hasData: tripCount > 0,
    tripCount,
    totalCost,
    costPerTrip: tripCount > 0 ? totalCost / tripCount : null,
    totalKm,
    costPerKm: totalKm > 0 ? totalCost / totalKm : null,
    costPerVisit: null,
    costPerTripVisit: null,
    windowSalesValue: null,
    expenseToSalesPct: null,
    expenseVsSalesMonths: null,
    claimsThrough: null,
    noDestinationTrips: noDestinationCount,
    unresolvedTrips: unresolved.sort((a, b) => b.total - a.total),
    meetingCount,
    byType,
    categories,
    byDestination,
    monthly,
    topTrips,
    transportMix,
    approvedCount,
    approvedCost,
    rejectedCount,
    pendingCount,
    amWorkload,
    pharmacyWorkload,
    pharmacyUncountedTrips,
    pmWorkload,
    summaryText,
  };
}

/**
 * Outstation requests submitted in Phoenix (`outstation_expense_requests`). The product no longer
 * computes a variance or a fraud signal, so neither is read or shown; an eligibility or territory
 * issue still flags a request. A rejected request is left out and only counted, as in the payroll
 * summary above: "Claimed" read higher than anything the person could ever be paid.
 */
export function summarizeOutstationRequests(outRows: readonly OutstationRow[]): OutstationSummary {
  let claimedTotal = 0;
  let expectedTotal = 0;
  let flaggedCount = 0;
  let rejectedCount = 0;
  for (const o of outRows) {
    if (expenseApprovalState({ hrApproved: null, status: o.status }) === "rejected") {
      rejectedCount += 1;
      continue;
    }
    claimedTotal += Number(o.claimed_total_amount ?? 0);
    expectedTotal += Number(o.expected_total_amount ?? 0);
    const eligIssue = o.eligibility_status != null && o.eligibility_status !== "eligible";
    // 🔴 `"valid"` WAS NOT ONE OF THE THREE VALUES THIS COLUMN CAN HOLD. They are `matched`,
    // `outside_expected_territory` and `not_available` — so `!== "valid"` was true for every row
    // with a status at all, and none is null. This counted 153 of 153 outstation trips as
    // territory-flagged, for every employee, always.
    //
    // Correcting the string alone would not have helped: `!== "matched"` still flags ~100%, because
    // an outstation trip is BY DEFINITION outside the employee's own area. `matched` is the odd
    // one — a claim for travel inside their own territory — so that is the flag.
    const territoryIssue = o.territory_validation_status === "matched";
    if (eligIssue || territoryIssue) flaggedCount += 1;
  }
  return {
    hasData: outRows.length > 0,
    rejectedCount,
    tripCount: outRows.length - rejectedCount,
    claimedTotal,
    expectedTotal,
    flaggedCount,
  };
}

// ── Training-manager identity ────────────────────────────────────────────────
/**
 * Who is a Training Manager, decided the way the CRM double-visit analytics decides it: the job
 * FUNCTION of the employee's job title or position title (`resolveJobFunctionRole`), never a
 * substring of the title. A "%training%" match also caught any title that merely mentions
 * training, and missed a Training Manager recorded only by position. In a Phoenix visit the
 * Training Manager rides in the product-manager seat (`product_manager_hr_id`), which the visits
 * door hands on as the double partner, so the double-visit columns are where this set is checked.
 *
 * Keys are trimmed and lower-cased, which is how every reader below looks them up.
 */
export function trainingManagerKeysOf(
  rows: ReadonlyArray<{ hrId: string | null; jobTitle?: string | null; positionTitle?: string | null }>,
): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    const hrId = String(row.hrId ?? "").trim().toLowerCase();
    if (!hrId) continue;
    if (
      resolveJobFunctionRole(row.jobTitle) === "Training Manager" ||
      resolveJobFunctionRole(row.positionTitle) === "Training Manager"
    ) {
      set.add(hrId);
    }
  }
  return set;
}

async function getTrainingManagerHrIds(): Promise<Set<string>> {
  // Former Training Managers stay in: a double visit from last year was still a training visit.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  return trainingManagerKeysOf(directory);
}

// ── Leadership activity (coaching + double-visits DELIVERED) ──────────────────
// The RECEIVING-end sections (coaching received, double-visits received) describe
// a rep. A leader (DM / RM / NSM / PM / TM) is judged on the DELIVERING end: the
// coaching reports they authored, the double-visits where THEY were the
// accompanying manager, and how many distinct reps that reached. All window-scoped
// to the selected period. For Training Managers we also compute a bounded
// before/after IMPACT aggregate across the reps they double-visited (their
// signature metric) — reusing the same poolImpact engine as the rep-level view.
export type LeaderRepTouch = {
  hrId: string;
  name: string | null;
  coachingReports: number;
  doubleVisits: number;
  avgScoreGiven: number | null;
  lastTouch: string | null;
};
export type LeaderCoachingEvent = { date: string; repName: string | null; scorePercent: number | null; zone: string | null };
export type LeaderDvEvent = { date: string; repName: string | null; kind: "Regular" | "Unplanned" | "Other"; customerName: string | null };
export type LeadershipActivity = {
  hasData: boolean;
  coachingDelivered: number;
  coachingRepsReached: number;
  avgScoreGiven: number | null;
  /**
   * The double visits he CONDUCTED: the iReports360 ones from the visits door, plus his Phoenix CRM ride-alongs read
   * through `loadManagerRideAlongDetails`. Null when the Phoenix CRM read failed — never a figure that left half out.
   */
  dvConducted: number | null;
  /** The distinct days those double visits were made on (owner, 2026-10-27). Null when the Phoenix CRM read failed. */
  dvDays: number | null;
  /** The same visits, one figure per kind. Null when the Phoenix CRM read failed. */
  dvByKind: ConductedByKind | null;
  /**
   * The conducted double visits AM · PM · Pharmacies apart (owner, 2026-10-23), campaign ones in their half as on the rep's
   * own page. With `dvAwaitingValidation` it adds up to `dvConducted`, so the tile's figures never disagree.
   */
  dvSplit: VisitCountSplit | null;
  /** Phoenix CRM ride-alongs whose customer is not validated yet: in the headline, held out of the split — the calendar's rule. */
  dvAwaitingValidation: number | null;
  /**
   * His OWN visits logged in Phoenix CRM, which no visits door carries (owner, 2026-10-23: "the manager himself
   * can submit a single visit … any record submitted by himself … must appear"). `visits` is the ones he made ALONE;
   * `withSenior` the ones on a half-day planned with his own manager or a product manager, which are never single
   * (owner, 2026-10-27). Null when that read failed — never a zero that was not measured.
   */
  ownSingle: { visits: number; split: VisitCountSplit; withSenior: { visits: number; split: VisitCountSplit } } | null;
  dvRepsReached: number;
  distinctRepsReached: number;
  byRep: LeaderRepTouch[];
  /**
   * Conducted double visits on a CRM account that maps to no employee on that date — in the headline, so the reps list
   * prints them on a line of their own and its figures add up to it. Never named after whoever holds the account now.
   */
  dvUnmatched: number;
  recentCoaching: LeaderCoachingEvent[];
  recentDv: LeaderDvEvent[];
  /** Bounded before/after aggregate across double-visited reps (Training Managers only); null otherwise or when the sample is empty. */
  impact: ImpactSet | null;
  impactRepCount: number;
  /** True when any underlying read hit its cap (impact 12k / dv 8k / coaching 3k) — the counts may
   * undercount; surfaced in summaryText. */
  truncated: boolean;
  summaryText: string;
};

type DeliveredCoachingRow = {
  medical_rep_hr_id: string | null;
  coaching_date: string | null;
  final_score_percent: number | null;
  performance_zone: string | null;
};
/** Conducted double visits by kind: with one rep, a chain (two leaders and a rep), with a product or training manager. */
export type ConductedByKind = { doubles: number; chains: number; productManagerVisits: number };

type ConductedDvRow = {
  agent_hr_id: string | null;
  /** Phoenix's own unplanned flag (out of list or out of plan); null on an archive row. */
  is_unplanned?: boolean | null;
  agent_name: string | null;
  /** Negative on a Phoenix CRM row in the unified door. */
  crm_visit_id?: number | null;
  double2_hr_id?: string | null;
  ampm?: string | null;
  speciality?: string | null;
  source?: string | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
  contact_name: string | null;
  customer_name: string | null;
};
type RepVisitRow = {
  agent_hr_id: string | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  customer_name: string | null;
};

const MAX_IMPACT_REPS = 40;

function foldImpactMetricsAcross(list: ImpactMetrics[]): ImpactMetrics {
  return {
    visitsPerActiveDay: meanNullable(list.map((m) => m.visitsPerActiveDay)),
    campaignShare: meanNullable(list.map((m) => m.campaignShare)),
    distinctCustomers: roundOrNull(meanNullable(list.map((m) => m.distinctCustomers))),
    sampleDays: list.reduce((s, m) => s + m.sampleDays, 0),
    sampleVisits: list.reduce((s, m) => s + m.sampleVisits, 0),
  };
}

// Aggregate before/after across the reps this leader double-visited. Bounded to
// MAX_IMPACT_REPS (most-visited first) and two queries total, so it stays a
// page-load-safe read. `dvByRep` is keyed by lower(agent_hr_id).
async function computeLeaderImpact(
  dvByRep: Map<string, { exactIds: Set<string>; dates: string[] }>,
): Promise<{ impact: ImpactSet | null; repCount: number; truncated: boolean }> {
  const capped = Array.from(dvByRep.entries())
    .sort((a, b) => b[1].dates.length - a[1].dates.length)
    .slice(0, MAX_IMPACT_REPS);
  if (capped.length === 0) return { impact: null, repCount: 0, truncated: false };

  const exactIds = Array.from(new Set(capped.flatMap(([, v]) => Array.from(v.exactIds)))).filter(Boolean);
  const allDates = capped.flatMap(([, v]) => v.dates).sort();
  if (exactIds.length === 0 || allDates.length === 0) return { impact: null, repCount: 0, truncated: false };
  const minDate = addDays(allDates[0], -(IMPACT_WINDOW_DAYS + 1));
  const maxDate = addDays(allDates[allDates.length - 1], IMPACT_WINDOW_DAYS + 1);

  // Reads through the CRM single-door layer (resigned/owner-excluded agents removed there).
  const data = await queryVisitsLimited<RepVisitRow>({
    agentHrIds: exactIds,
    dateFrom: minDate,
    dateTo: maxDate,
    columns: "agent_hr_id, visit_date, visit_type, visit_type_description, comment, contact_crm_id, contact_name, customer_name",
    limit: 12000,
  });
  // The 12,000-row cap (newest-first) can silently drop older rows and skew the before/after window.
  const truncated = data.length >= 12000;

  const rowsByRep = new Map<string, ProductiveRow[]>();
  for (const r of data) {
    if (!r.visit_date || !isProductiveVisit(r)) continue;
    const key = String(r.agent_hr_id ?? "").trim().toLowerCase();
    const list = rowsByRep.get(key) ?? [];
    list.push({
      date: r.visit_date,
      isCampaign: r.visit_type === CAMPAIGN_TYPE,
      // Contact 0 (every campaign visit) and the catch-all are nobody — see customerKeyOf.
      customer: customerKeyOf(r) ?? "",
    });
    rowsByRep.set(key, list);
  }

  const perRep: ImpactSet[] = [];
  for (const [key, v] of capped) {
    const rows = rowsByRep.get(key) ?? [];
    if (rows.length === 0) continue;
    // The read covers a full span either side of every event, so only an "after" not yet over is cut.
    const set = poolImpact(rows, v.dates, IMPACT_WINDOW_DAYS, { from: minDate, to: addDays(todayInCairo(), -1) });
    if (set.eventCount > 0) perRep.push(set);
  }
  if (perRep.length === 0) return { impact: null, repCount: 0, truncated: false };

  return {
    impact: {
      eventCount: perRep.reduce((s, x) => s + x.eventCount, 0),
      windowDays: IMPACT_WINDOW_DAYS,
      before: foldImpactMetricsAcross(perRep.map((p) => p.before)),
      after: foldImpactMetricsAcross(perRep.map((p) => p.after)),
    },
    repCount: perRep.length,
    truncated,
  };
}

/**
 * The AM · PM · Pharmacies bucket a conducted double visit counts in, or null for a row that is not field work. Through
 * `visitCountBucket`, the golden rule's one helper; a pharmacy is a pharmacy whatever its period. A CAMPAIGN double visit
 * counts in its half, as the rep's own page counts it (`summarizeVisits`): until 2026-10-27 it was in none while the
 * headline counted it, and Dina Hamdy's tile read 712 over a split of 496 — 209 campaign doubles and 7 ride-alongs
 * awaiting validation short.
 */
export function conductedVisitBucket(row: Pick<ConductedDvRow, "ampm" | "comment" | "source" | "speciality" | "visit_type" | "visit_type_description">) {
  if (!isFieldWorkVisit(row.visit_type, row.comment, row.visit_type_description)) return null;
  return visitCountBucket({
    ampm: row.ampm ?? null,
    comment: row.comment,
    source: row.source ?? null,
    speciality: row.speciality ?? null,
    visit_type: row.visit_type,
    visit_type_description: row.visit_type_description,
  });
}

/**
 * The AM · PM · Pharmacies bucket of one Phoenix CRM visit, by the same rule `managerDayFigures` uses: the customer's
 * list decides, and only a customer on his own Manager's list (no list) falls back to the half he logged it in. A
 * visit whose customer is not validated yet is in no figure.
 */
function phoenixVisitBucket(visit: ManagerDayVisit) {
  if (visit.awaitingValidation) return null;
  return visitCountBucketForListType(visit.source === "own" && visit.listType === null ? visit.bucket : visit.listType);
}

function splitOf(visits: readonly ManagerDayVisit[]): VisitCountSplit {
  const split = emptyVisitCountSplit();
  for (const visit of visits) {
    const bucket = phoenixVisitBucket(visit);
    if (bucket) addBucketToSplit(split, bucket);
  }
  return { am: split.am, pharmacies: split.pharmacies, pm: split.pm };
}

export type LeaderPhoenixFigures = {
  /** His own visits made alone. */
  ownSingle: { visits: number; split: VisitCountSplit };
  /** His own visits on a half-day planned with his own manager or a product manager — never counted as single. */
  ownWithSenior: { visits: number; split: VisitCountSplit };
  /** The ride-alongs he joined in Phoenix CRM, one figure per kind. */
  rides: ConductedByKind;
  /** The day of every ride-along counted in `rides`, so the conducted double visits can say on how many days. */
  rideDates: string[];
  rideSplit: VisitCountSplit;
  /** The ride-alongs whose customer is not validated yet: in `rides`, never in `rideSplit`. */
  rideAwaitingValidation: number;
};

/**
 * PURE. A leader's Phoenix CRM visits (`loadManagerVisitDetails`) as the leadership figures: his own visits alone and
 * with a senior apart, and the ride-alongs by kind — every count through `managerDayFigures`, the calendar's own.
 */
export function leaderVisitFigures(visits: readonly ManagerDayVisit[]): LeaderPhoenixFigures {
  const own = visits.filter((v) => v.source === "own");
  const ownAlone = own.filter((v) => v.kind !== "with_senior");
  const ownWithSenior = own.filter((v) => v.kind === "with_senior");
  const rides = visits.filter((v) => v.source === "ride_along");
  const ownFigures = managerDayFigures(own);
  const rideFigures = managerDayFigures(rides);
  return {
    ownSingle: { visits: ownFigures.ownSingle, split: splitOf(ownAlone) },
    ownWithSenior: { visits: ownFigures.ownWithSenior, split: splitOf(ownWithSenior) },
    rides: { chains: rideFigures.chains, doubles: rideFigures.doubles, productManagerVisits: rideFigures.productManagerVisits },
    rideAwaitingValidation: rideFigures.awaitingValidation,
    rideDates: rides.filter((v) => v.kind === "double" || v.kind === "chain" || v.kind === "product_manager").map((v) => v.date),
    rideSplit: splitOf(rides),
  };
}

/**
 * PURE. The double visits a leader conducted, from both sides without counting one twice: the iReports360 rows of the
 * visits door, and his Phoenix CRM ride-alongs. The door's own Phoenix rows are the same visits as the ride-alongs,
 * so they are left out here and the ride-alongs counted instead (they carry the kind and the product-manager seat).
 * `days` is the distinct days those same visits were made on (owner, 2026-10-27: "how many days").
 * Null Phoenix visits (that read failed) is null — never a figure that left half the work out.
 *
 * `split` and `awaitingValidation` count the same visits as `total`: every door row is field work (the read asks for
 * the double-visit types only) and lands in one bucket, and a ride-along is in the split or awaiting validation.
 */
export function conductedDoubleVisitFigures(
  doorRows: ReadonlyArray<Pick<ConductedDvRow, "ampm" | "comment" | "crm_visit_id" | "double2_hr_id" | "source" | "speciality" | "visit_date" | "visit_type" | "visit_type_description">>,
  phoenix: LeaderPhoenixFigures | null,
): { total: number; days: number; byKind: ConductedByKind; split: VisitCountSplit; awaitingValidation: number } | null {
  if (!phoenix) return null;
  const byKind: ConductedByKind = { ...phoenix.rides };
  const split = emptyVisitCountSplit();
  split.am = phoenix.rideSplit.am;
  split.pm = phoenix.rideSplit.pm;
  split.pharmacies = phoenix.rideSplit.pharmacies;
  const days = new Set(phoenix.rideDates);
  for (const row of doorRows) {
    if (isPhoenixNativeVisitRow(row)) continue;
    if (row.visit_date) days.add(row.visit_date);
    if (String(row.double2_hr_id ?? "").trim()) byKind.chains += 1;
    else byKind.doubles += 1;
    const bucket = conductedVisitBucket(row);
    if (bucket) addBucketToSplit(split, bucket);
  }
  return {
    awaitingValidation: phoenix.rideAwaitingValidation,
    byKind,
    days: days.size,
    split: { am: split.am, pharmacies: split.pharmacies, pm: split.pm },
    total: byKind.doubles + byKind.chains + byKind.productManagerVisits,
  };
}

/**
 * PURE. The conducted double visits the reps list cannot name: an iReports360 row whose account maps to no employee on
 * that date (no `agent_hr_id`). They are in the headline, so the list prints them as a line of their own and adds up to
 * it — on 2026-10-27 Dina Hamdy's list summed to 705 under a headline of 712, the 7 being visits of 2 to 5 August on a
 * Tanta account before its holder's hire date. A Phoenix row is counted through its ride-along, never here.
 */
export function unmatchedConductedDoubleVisits(
  doorRows: ReadonlyArray<Pick<ConductedDvRow, "agent_hr_id" | "crm_visit_id" | "source">>,
): number {
  return doorRows.filter((row) => !isPhoenixNativeVisitRow(row) && !String(row.agent_hr_id ?? "").trim()).length;
}

/**
 * PURE. A leader's own Phoenix CRM visits as visit rows, so they count in his own field presence (owner, 2026-10-23:
 * "any record submitted by himself … must appear"). The visits door never carries them, so nothing is counted twice.
 * Each is a regular visit to the customer he named, in the bucket of his customer's list (or the half he logged it in
 * on his own Manager's list). A visit whose customer is not validated yet is left out, as in every figure.
 */
export function managerOwnVisitsAsVisitRows(visits: readonly ManagerDayVisit[]): VisitRow[] {
  const rows: VisitRow[] = [];
  for (const v of visits) {
    if (v.source !== "own" || v.awaitingValidation) continue;
    rows.push({
      ampm: v.listType ?? v.bucket,
      comment: null,
      contact_crm_id: null,
      contact_name: v.customerName,
      customer_name: v.customerName,
      double_crm_id: null,
      double_hr_id: null,
      double_name: null,
      source: "phoenix",
      speciality: v.speciality,
      visit_date: v.date,
      visit_type: REGULAR_TYPE,
      visit_type_description: null,
    });
  }
  return rows;
}

async function getLeadershipActivity(
  hrId: string,
  window: Employee360Window,
  nameByHrId: Map<string, string>,
  computeImpact: boolean,
  /** His Phoenix CRM visits (own and ride-alongs) for the window, read once by the profile; null when that read failed.
   * Passed still IN FLIGHT, so the two reads below run beside it instead of after it. */
  phoenixVisitsRead: Promise<readonly ManagerDayVisit[] | null>,
): Promise<LeadershipActivity> {
  const supabase = getSupabaseAdmin();
  const keys = hrIdLookupKeys(hrId);
  const today = todayInCairo();

  const [coachRes, dvRows, phoenixVisits] = await Promise.all([
    supabase
      .from("coaching_reports")
      .select("medical_rep_hr_id,coaching_date,final_score_percent,performance_zone")
      .in("coach_hr_id", keys)
      // Completed reports only — the coaching module's own definition; a draft is not coaching delivered.
      .in("status", [...completedReportStatuses])
      .gte("coaching_date", window.from)
      .lte("coaching_date", window.to)
      .limit(3000),
    // Double visits CONDUCTED by this leader — read through the CRM single door (which matches
    // hr ids case-insensitively, so the raw id suffices; `keys` stays for the coaching query).
    queryVisitsLimited<ConductedDvRow>({
      doubleHrIds: [hrId],
      dateFrom: window.from,
      dateTo: window.to,
      // Only real fieldwork double visits count as "double-visits conducted" — a manager tagged as
      // a partner on a Meeting/Training/Vacation row is not one. And collapse burst-duplicate
      // re-saves so the headline count matches the canonical double-visit definition.
      visitTypes: CRM_DOUBLE_VISIT_TYPE_CODES,
      columns: "agent_hr_id, agent_name, crm_visit_id, double2_hr_id, visit_date, visit_type, visit_type_description, comment, contact_name, customer_name, ampm, speciality, source, is_unplanned",
      limit: 8000,
      collapseDoubleVisits: true,
    }),
    phoenixVisitsRead,
  ]);
  const phoenix = phoenixVisits ? leaderVisitFigures(phoenixVisits) : null;
  const ownSingle = phoenix ? { ...phoenix.ownSingle, withSenior: phoenix.ownWithSenior } : null;
  const conducted = conductedDoubleVisitFigures(dvRows, phoenix);
  if (coachRes.error) throw new Error(`Employee 360 coaching delivered: ${coachRes.error.message}`);

  const coachRows = ((coachRes.data ?? []) as DeliveredCoachingRow[]).filter(
    (r) => r.coaching_date && r.coaching_date <= today,
  );

  // Per-rep aggregation, keyed case-insensitively so the coaching feed
  // (medical_rep_hr_id) and the CRM visit feed (agent_hr_id) merge cleanly.
  const byRep = new Map<string, { name: string | null; coachingReports: number; doubleVisits: number; scoreSum: number; scoreCount: number; lastTouch: string | null }>();
  const touch = (key: string, name: string | null, date: string | null) => {
    const cur = byRep.get(key) ?? { name: null, coachingReports: 0, doubleVisits: 0, scoreSum: 0, scoreCount: 0, lastTouch: null };
    if (!cur.name && name) cur.name = name;
    if (date && (!cur.lastTouch || date > cur.lastTouch)) cur.lastTouch = date;
    byRep.set(key, cur);
    return cur;
  };

  let scoreSumAll = 0;
  let scoreCountAll = 0;
  const recentCoaching: LeaderCoachingEvent[] = [];
  for (const r of coachRows) {
    const key = String(r.medical_rep_hr_id ?? "").trim().toLowerCase();
    if (!key) continue;
    const repName = nameByHrId.get(key) ?? r.medical_rep_hr_id ?? null;
    const cur = touch(key, repName, r.coaching_date);
    cur.coachingReports += 1;
    const score = r.final_score_percent != null ? Number(r.final_score_percent) : null;
    if (score != null) {
      cur.scoreSum += score;
      cur.scoreCount += 1;
      scoreSumAll += score;
      scoreCountAll += 1;
    }
    recentCoaching.push({ date: String(r.coaching_date), repName, scorePercent: score, zone: r.performance_zone });
  }

  const dvByRepForImpact = new Map<string, { exactIds: Set<string>; dates: string[] }>();
  const recentDv: LeaderDvEvent[] = [];
  const dvUnmatched = unmatchedConductedDoubleVisits(dvRows);
  for (const r of dvRows) {
    if (!r.visit_date) continue;
    const rawId = String(r.agent_hr_id ?? "").trim();
    const key = rawId.toLowerCase();
    if (!key) continue;
    const repName = nameByHrId.get(key) ?? r.agent_name ?? null;
    const cur = touch(key, repName, r.visit_date);
    cur.doubleVisits += 1;
    const bucket = classifyVisit(r.visit_type, r.comment, r.visit_type_description).bucket;
    const kind = bucket === "regular" || bucket === "campaign" ? (isUnplannedFieldVisit(r) ? "Unplanned" : "Regular") : "Other";
    recentDv.push({ date: r.visit_date, repName, kind, customerName: r.contact_name ?? r.customer_name ?? null });
    const imp = dvByRepForImpact.get(key) ?? { exactIds: new Set<string>(), dates: [] };
    if (rawId) imp.exactIds.add(rawId);
    imp.dates.push(r.visit_date);
    dvByRepForImpact.set(key, imp);
  }

  const coachingRepsReached = new Set(coachRows.map((r) => String(r.medical_rep_hr_id ?? "").trim().toLowerCase()).filter(Boolean)).size;
  const dvRepsReached = dvByRepForImpact.size;
  const distinctRepsReached = byRep.size;

  const byRepList: LeaderRepTouch[] = Array.from(byRep.entries())
    .map(([hrIdKey, v]) => ({
      hrId: hrIdKey.toUpperCase(),
      name: v.name,
      coachingReports: v.coachingReports,
      doubleVisits: v.doubleVisits,
      avgScoreGiven: v.scoreCount > 0 ? v.scoreSum / v.scoreCount : null,
      lastTouch: v.lastTouch,
    }))
    .sort((a, b) => b.coachingReports + b.doubleVisits - (a.coachingReports + a.doubleVisits));

  recentCoaching.sort((a, b) => b.date.localeCompare(a.date));
  recentDv.sort((a, b) => b.date.localeCompare(a.date));

  const { impact, repCount, truncated: impactTruncated } = computeImpact
    ? await computeLeaderImpact(dvByRepForImpact)
    : { impact: null, repCount: 0, truncated: false };
  // Honest cap signal across all three underlying reads (impact 12k, dv 8k, coaching 3k).
  const truncated = impactTruncated || dvRows.length >= 8000 || (coachRes.data?.length ?? 0) >= 3000;

  const avgScoreGiven = scoreCountAll > 0 ? scoreSumAll / scoreCountAll : null;
  const ownVisits = ownSingle?.visits ?? 0;
  const ownWithSenior = ownSingle?.withSenior.visits ?? 0;
  const dvConducted = conducted?.total ?? null;
  const dvDays = conducted?.days ?? null;
  // A failed Phoenix CRM read still draws the section, so its figures can say "—" instead of the empty state's "none".
  const hasData = phoenix === null || coachRows.length > 0 || dvRows.length > 0 || (dvConducted ?? 0) > 0 || ownVisits > 0 || ownWithSenior > 0;
  const ownSentence =
    (ownVisits > 0 ? ` Made ${ownVisits} own single visit${ownVisits === 1 ? "" : "s"}.` : "") +
    (ownWithSenior > 0 ? ` Made ${ownWithSenior} own visit${ownWithSenior === 1 ? "" : "s"} with their own manager or a product manager.` : "") +
    (phoenix ? "" : " The Phoenix CRM visits could not be read just now, so they are not in these figures.");
  const dvPhrase =
    dvConducted === null
      ? "double-visits that could not all be read"
      : `${dvConducted} double-visit${dvConducted === 1 ? "" : "s"}` + (dvDays ? ` on ${dvDays} day${dvDays === 1 ? "" : "s"}` : "");
  const baseSummaryText = !hasData
    ? "No coaching reports authored, double-visits conducted or own visits logged in this period."
    : `Delivered ${coachRows.length} coaching report${coachRows.length === 1 ? "" : "s"} and ${dvPhrase}, ` +
      `reaching ${distinctRepsReached} distinct rep${distinctRepsReached === 1 ? "" : "s"}` +
      (avgScoreGiven != null ? ` at an average coaching score of ${Math.round(avgScoreGiven)}%.` : ".") +
      ownSentence;
  const summaryText = truncated
    ? `${baseSummaryText} Some rows were capped for performance, so these figures may undercount.`
    : baseSummaryText;

  return {
    hasData,
    coachingDelivered: coachRows.length,
    coachingRepsReached,
    avgScoreGiven,
    dvConducted,
    dvDays,
    dvByKind: conducted?.byKind ?? null,
    dvSplit: conducted?.split ?? null,
    dvAwaitingValidation: conducted?.awaitingValidation ?? null,
    dvUnmatched,
    ownSingle,
    dvRepsReached,
    distinctRepsReached,
    // Every rep, never the top 30: with the unmatched line the list adds up to the headline (2026-10-27).
    byRep: byRepList,
    recentCoaching: recentCoaching.slice(0, 12),
    recentDv: recentDv.slice(0, 12),
    impact,
    impactRepCount: repCount,
    truncated,
    summaryText,
  };
}

// ── Field benchmarks (company-wide, computed live) ───────────────────────────
// The company figures a person is set beside. Until 2026-09-25 three of them were literals measured
// once on 2026-07-12 — the share of reps with linked sales, the company achievement beside a rep's own,
// and the count of reps ever coached — and the screen kept printing them as the field force changed.
// tests/employee-360-live-field-benchmarks.test.ts fails if any of the three is written back in.
// Each is now worked out on every load from rows the profile already reads, and carries the month it
// describes. (The visit averages in benchmarks.ts are a separate, heavier question and stay as they are.)
export type Employee360FieldBenchmarks = {
  /** Active Medical Reps on the directory today — the denominator of both coverage figures. */
  fieldReps: number;
  /** Of them, how many hold at least one published sales row — the same test as a rep's "Sales linked". */
  repsWithSales: number;
  /** The company's achievement under the closing's rule, the company as the subject; null when no month carries a target. */
  companyAchievementPct: number | null;
  /** The latest published closing month holding sales ("Sep 2026") — what both sales figures run through. */
  salesThroughLabel: string | null;
  /** Of the field reps, how many have ever been coached; null when that read failed, so no figure is shown. */
  repsEverCoached: number | null;
  /** The month the roster and the coaching count describe ("Sep 2026", Cairo). */
  asOfLabel: string;
};

/**
 * PURE. `salesRows` are the company's published-closing rows after the viewer's product mask — the same
 * rows a rep's own figures are cut from, so the two sit on one basis.
 */
export function summarizeFieldBenchmarks(input: {
  fieldRepHrIds: readonly string[];
  salesRows: readonly SalesRow[];
  coachedRepHrIds: readonly string[] | null;
  asOfMonth: string;
}): Employee360FieldBenchmarks {
  const keyed = (ids: Iterable<string | null>) => {
    const out = new Set<string>();
    for (const id of ids) {
      const key = canonicalHrIdKey(id);
      if (key) out.add(key);
    }
    return out;
  };
  const reps = keyed(input.fieldRepHrIds);
  const repsWithSales = [...keyed(input.salesRows.map((r) => r.employee_hr_id))].filter((k) => reps.has(k)).length;
  const coached = input.coachedRepHrIds == null ? null : [...keyed(input.coachedRepHrIds)].filter((k) => reps.has(k)).length;
  const company = aggregateSalesRows([...input.salesRows], false, 0);
  return {
    fieldReps: reps.size,
    repsWithSales,
    companyAchievementPct: company.achievementPct,
    salesThroughLabel: company.latestMonth ? monthLabel(company.latestMonth) : null,
    repsEverCoached: coached,
    asOfLabel: monthLabel(input.asOfMonth),
  };
}

/** Every rep with a coaching report dated today or earlier — the per-rep section's own future-date cut. Null on a failed read. */
async function loadCoachedRepHrIds(): Promise<string[] | null> {
  try {
    const today = todayInCairo();
    const rows = await fetchAllRows<{ id: string; medical_rep_hr_id: string | null }>(
      () =>
        getSupabaseAdmin()
          .from("coaching_reports")
          .select("id,medical_rep_hr_id")
          .in("status", [...completedReportStatuses])
          .lte("coaching_date", today),
      "id",
    );
    return rows.map((r) => String(r.medical_rep_hr_id ?? "")).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The live company figures for this viewer. The sales rows, the hire months and the directory are
 * the loads the profile and its page already made (memoized per request, or cached), so the only new
 * read is the coaching one. Null when anything fails: a missing company figure is honest, a stale one
 * is not.
 */
async function getFieldBenchmarks(viewerRole: PhoenixRole): Promise<Employee360FieldBenchmarks | null> {
  try {
    const { year, month } = currentCairoDateParts();
    const [directory, all, coachedRepHrIds] = await Promise.all([
      getEmployeeDirectoryRows({ includeInactive: true }),
      // Published months, each credited to the rep who held the seat then (sales-canonical.ts).
      loadCanonicalEmployee360SalesRows(),
      loadCoachedRepHrIds(),
    ]);
    let salesRows = maskRestrictedEmployee360Rows(all, viewerRole);
    if (!canViewRestrictedProducts(viewerRole)) {
      salesRows = applyRestrictedProductFilter(salesRows, viewerRole, await restrictedProductNameSet());
    }
    const fieldRepHrIds = directory
      .filter((row) => isActiveDirectoryEmployee(row) && resolveEmployee360RoleCategory(row.jobTitle ?? row.positionTitle) === "medical-rep")
      .map((row) => row.hrId);
    return summarizeFieldBenchmarks({
      fieldRepHrIds,
      salesRows,
      coachedRepHrIds,
      asOfMonth: `${year}-${String(month).padStart(2, "0")}`,
    });
  } catch {
    return null;
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export type Employee360Profile = Employee360Summary & {
  /** Live company figures (sales coverage, company achievement, coaching coverage); null when unavailable. */
  fieldBenchmarks: Employee360FieldBenchmarks | null;
  sales: SalesSummary;
  coaching: CoachingSummary;
  doubleVisits: DoubleVisitHistory;
  impact: InterventionImpact;
  expenses: EmployeeExpenses;
  leadership: LeadershipActivity | null;
  /** The area-vs-list brick panel — Medical Reps only; null for every other role. */
  bricks: Employee360BrickPanel | null;
};

/**
 * The rep's CURRENT list as contact -> lists, for placing a most-visited customer as an AM doctor,
 * a PM doctor or a pharmacy. Undefined when it cannot be read: the customers are then placed by
 * their visits' own signals (customerLaneOf), never dropped and never failing the profile.
 */
async function loadRepListsByContact(hrId: string): Promise<Map<number, Set<CrmListType>> | undefined> {
  try {
    const rows = await getRepContactList(hrId);
    const out = new Map<number, Set<CrmListType>>();
    for (const row of rows) {
      const lists = out.get(row.contactCrmId) ?? new Set<CrmListType>();
      lists.add(row.listType);
      out.set(row.contactCrmId, lists);
    }
    return out;
  } catch {
    return undefined;
  }
}

export async function getEmployee360Profile(
  hrId: string,
  nameByHrId: Map<string, string>,
  window: Employee360Window = defaultWindow(),
  teamHrIds: string[] = [hrId],
  includeExpenses: boolean = true,
  viewerRole: PhoenixRole = "Employee",
  roleCategory: Employee360RoleCategory | null = null,
  /** The READER's own hr id. It decides nothing but one thing: a reader opening his OWN profile reads
   * his Phoenix rows at the `none` tier (owner, 2026-09-29, absolute). Null means "not the subject",
   * which is the safe default for a caller that has no reader to name. */
  viewerHrId: string | null = null,
): Promise<Employee360Profile> {
  const salesTeam = teamHrIds.length ? teamHrIds : [hrId];
  const isLeader = isFieldLeaderCategory(roleCategory);
  // PM / Group PM: attribute sales by the PRODUCTS they own (product master), not a
  // team roll-up (they have no reports). Falls back to the team path when a PM has
  // no assignments yet (or before the pm_product_assignments migration is applied).
  // A chain, not an await: the PM's two product reads used to hold every other read below back.
  const salesPromise =
    roleCategory === "product-manager"
      ? getPmProductCodes(hrId)
          .then(resolvePmSalesFamilies)
          .then((pmSalesFamilies) =>
            pmSalesFamilies.length > 0
              ? getEmployeeSalesByFamilies(pmSalesFamilies, viewerRole)
              : getEmployeeSales(hrId, salesTeam, viewerRole),
          )
      : getEmployeeSales(hrId, salesTeam, viewerRole);
  // A leader's Phoenix CRM visits — his own and the ride-alongs he joined — read ONCE: the leadership figures and his
  // own field presence both come from it. `productManagerSlot` lets a Training or product manager's seat count too;
  // for a district manager it answers the first two seats exactly as before. A failed read is null, never a zero.
  const phoenixVisitsPromise: Promise<ManagerDayVisit[] | null> = isLeader
    ? loadManagerVisitDetails({ end: window.to, managerHrIds: [hrId], productManagerSlot: true, start: window.from }).catch((error) => {
        console.error("[employee-360] the leader's Phoenix CRM visits could not be read", error);
        return null;
      })
    : Promise.resolve(null);
  // The call rate's working days: Saturday to Wednesday less the confirmed national holidays. Never throws.
  const holidaysPromise = loadCallRateHolidays(window.from, window.to);
  const [visits, checkins, sales, tmIds, expenses, leadership, bricks, listsByContact, fieldBenchmarks, coaching] = await Promise.all([
    fetchVisitRows(hrId, window),
    fetchCheckinRows(hrId, window, {
      includePhoenixCheckins: employee360ReaderSeesPhoenixCheckins(hrId, { hrId: viewerHrId, role: viewerRole }),
    }),
    salesPromise,
    getTrainingManagerHrIds(),
    includeExpenses ? getEmployeeExpenses(hrId, window) : Promise.resolve(emptyEmployeeExpenses()),
    isLeader
      ? getLeadershipActivity(hrId, window, nameByHrId, roleCategory === "training-manager", phoenixVisitsPromise)
      : Promise.resolve(null),
    // A rep's own area against his own current list. A manager's seat carries no area of his own.
    roleCategory === "medical-rep" ? loadEmployee360BrickPanel(hrId, window, viewerRole) : Promise.resolve(null),
    roleCategory === "medical-rep" ? loadRepListsByContact(hrId) : Promise.resolve(undefined),
    getFieldBenchmarks(viewerRole),
    // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the coaching reports
    // are read by the employee alone — nothing above feeds them — so they load with the rest instead
    // of after it. Still read even where the page hides the coaching section: the impact figures
    // below are built from its dates.
    getEmployeeCoaching(hrId, nameByHrId, window),
  ]);
  const [phoenixVisits, holidays] = await Promise.all([phoenixVisitsPromise, holidaysPromise]);

  // His own field presence counts the visits he logged himself in Phoenix CRM beside the visits door's rows. The door
  // never carries those, so none is counted twice. The impact rows, the double-visit history and `isMapped` below keep
  // reading the door alone.
  const fieldVisits = phoenixVisits ? [...visits, ...managerOwnVisitsAsVisitRows(phoenixVisits)] : visits;
  const visitSummary = summarizeVisits(fieldVisits, window, listsByContact, holidays);
  const checkinSummary = summarizeCheckins(checkins, fieldVisits, visitSummary);
  // ONE sight for the whole profile: this page has a single subject, so every Phoenix row on it belongs
  // to the same rep. `phoenixRowSight` still resolves it per row, which is what makes a rep opening his
  // own 360 read `none` while his manager reads the distance.
  const doubleVisits = buildDoubleVisitHistory(
    visits,
    tmIds,
    nameByHrId,
    phoenixRowSight(phoenixDetailViewer(viewerRole, viewerHrId), hrId),
  );

  // Period-matched sales: only the months the visit window touches, never `sales.totalSales`
  // (every month since the history floor). The two efficiency ratios and the expense ratio below
  // all share this one figure — see windowSalesEfficiency.
  const efficiency = windowSalesEfficiency({
    monthly: sales.monthly,
    window,
    isTeamRollup: sales.isTeamRollup,
    visits: fieldVisits
      .filter((v) => isProductiveVisit(v) && v.visit_date)
      .map((v) => ({ date: v.visit_date as string, customerKey: customerKeyOf(v) })),
  });
  sales.salesPerVisit = efficiency.salesPerVisit;
  sales.salesPerCustomer = efficiency.salesPerCustomer;

  // expense efficiency (cross-domain): cost per visit + expense as % of sales, both over the months the claims reach
  const ep = expenses.payroll;
  const spend = expenseEfficiencyOf({
    totalCost: ep.totalCost,
    expenseMonthly: ep.monthly,
    visitMonthly: visitSummary.monthly,
    salesMonthly: sales.monthly,
    salesMonths: efficiency.salesMonths,
    windowTo: window.to,
  });
  ep.costPerVisit = spend.costPerVisit;
  ep.claimsThrough = spend.claimsThrough;
  // A pharmacy visit is field work (owner, 2026-09-21), so it stays in the per-visit cost.
  const tripVisits = ep.amWorkload + ep.pmWorkload + (ep.pharmacyWorkload ?? 0);
  ep.costPerTripVisit = tripVisits > 0 ? ep.totalCost / tripVisits : null;
  ep.windowSalesValue = spend.matchedSalesValue;
  ep.expenseVsSalesMonths = spend.matchedMonths;
  ep.expenseToSalesPct = spend.expenseToSalesPct;

  // productive rows for the impact engine
  const productiveRows: ProductiveRow[] = visits
    .filter((v) => isProductiveVisit(v) && v.visit_date)
    .map((v) => ({
      date: v.visit_date as string,
      isCampaign: v.visit_type === CAMPAIGN_TYPE,
      customer: customerKeyOf(v) ?? "",
    }));

  const coachingDates = coaching.reports.map((r) => r.date);
  // Use the FULL visit set for TM dates (doubleVisits.events is capped for display).
  const tmDvDates = trainingManagerVisitDates(visits, tmIds);

  // The visit rows cover the window up to yesterday (today is still being logged): an event's spans must sit in it.
  const lastWholeDay = addDays(todayInCairo(), -1);
  const impactObserved = { from: window.from, to: window.to < lastWholeDay ? window.to : lastWholeDay };
  const impact: InterventionImpact = {
    windowDays: IMPACT_WINDOW_DAYS,
    coaching: poolImpact(productiveRows, coachingDates, IMPACT_WINDOW_DAYS, impactObserved),
    trainingDv: poolImpact(productiveRows, tmDvDates, IMPACT_WINDOW_DAYS, impactObserved),
  };

  return {
    hrId,
    window,
    benchmarks: EMPLOYEE_360_BENCHMARKS,
    fieldBenchmarks,
    isMapped: visits.length > 0,
    ...visitSummary,
    ...checkinSummary,
    sales,
    coaching,
    doubleVisits,
    impact,
    expenses,
    leadership,
    bricks,
  };
}
