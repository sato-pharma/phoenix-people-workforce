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
//  - Sales lags visits and covers ~2/3 of reps — a rep with no sales rows shows
//    "no validated sales", never 0%.
//  - Impact windows report their sample size so a thin before/after isn't oversold.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrIdLookupKeys } from "@/lib/hr-id";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { canViewRestrictedProducts, restrictedProductNameSet, stripRestrictedRowsByName } from "@/lib/sales/access-scope";
import {
  CAMPAIGN_TYPE,
  classifyVisit,
  defaultWindow,
  fetchCheckinRows,
  fetchVisitRows,
  isProductiveVisit,
  summarizeCheckins,
  summarizeVisits,
  type Employee360Summary,
  type Employee360Window,
  type VisitRow,
} from "./service";
import { EMPLOYEE_360_BENCHMARKS } from "./benchmarks";
import { canonicalizeLocation, canonicalizeTransport, resolveGovernorate } from "./egypt-locations";

const IMPACT_WINDOW_DAYS = 30;

// ── Sales ──────────────────────────────────────────────────────────────────
export type SalesMonthPoint = { month: string; sales: number; target: number; achievementPct: number | null };
export type SalesProduct = { product: string; family: string | null; sales: number; target: number; achievementPct: number | null };
export type SalesFamily = { family: string; sales: number; target: number; achievementPct: number | null };
export type SalesSummary = {
  hasData: boolean;
  totalSales: number;
  totalTarget: number;
  achievementPct: number | null;
  latestMonth: string | null;
  monthsCount: number;
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

// A manager's sales = the roll-up of their whole team (subject + all descendants).
// For a rep, teamHrIds is just [self], so this is their own sales.
//
// Confidential products (LA003/LA004/SS001 — see src/lib/sales/access-scope.ts,
// the single source of truth) are stripped BEFORE any aggregation, same as the
// Sales module: they must never surface in a total, KPI, chart, or product list
// for a non-CEO/Super-Admin viewer. sales_records keys products by NAME, so the
// name-based strip (not the code-based one) is the one that reaches this table.
// Pure, DB-free filter step — exported so the masking wiring is unit-testable
// without a Supabase round trip (see stripRestrictedRowsByName's own tests in
// tests/sales-restricted-products.test.ts for the underlying strip logic).
export function applyRestrictedProductFilter(
  rows: SalesRow[],
  viewerRole: PhoenixRole,
  restrictedNames: Set<string>,
): SalesRow[] {
  if (canViewRestrictedProducts(viewerRole)) return rows;
  return stripRestrictedRowsByName(rows, restrictedNames, (r) => r.product, true);
}

async function getEmployeeSales(teamHrIds: string[], viewerRole: PhoenixRole): Promise<SalesSummary> {
  const supabase = getSupabaseAdmin();
  const keys = Array.from(new Set(teamHrIds.flatMap((id) => hrIdLookupKeys(id))));
  const { data, error } = await supabase
    .from("sales_records")
    .select("employee_hr_id,line,family,product,month,year,sales_value,target_value")
    .in("employee_hr_id", keys)
    .limit(20000);
  if (error) throw new Error(`Employee 360 sales: ${error.message}`);
  let rows = (data ?? []) as SalesRow[];
  if (!canViewRestrictedProducts(viewerRole)) {
    rows = applyRestrictedProductFilter(rows, viewerRole, await restrictedProductNameSet());
  }
  const subjectKey = String(teamHrIds[0] ?? "").trim().toLowerCase();
  const contributingReps = new Set(rows.map((r) => String(r.employee_hr_id ?? "").trim().toLowerCase()).filter((k) => k && k !== subjectKey));
  const isTeamRollup = teamHrIds.length > 1 && contributingReps.size > 0;

  const monthMap = new Map<string, { sales: number; target: number }>();
  const productMap = new Map<string, { family: string | null; sales: number; target: number }>();
  const familyMap = new Map<string, { sales: number; target: number }>();
  let totalSales = 0;
  let totalTarget = 0;
  for (const r of rows) {
    const sales = Number(r.sales_value ?? 0);
    const target = Number(r.target_value ?? 0);
    totalSales += sales;
    totalTarget += target;
    if (r.month != null && r.year != null) {
      const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
      const m = monthMap.get(key) ?? { sales: 0, target: 0 };
      m.sales += sales;
      m.target += target;
      monthMap.set(key, m);
    }
    const pkey = (r.product ?? "—").trim() || "—";
    const p = productMap.get(pkey) ?? { family: r.family, sales: 0, target: 0 };
    p.sales += sales;
    p.target += target;
    productMap.set(pkey, p);
    const fkey = (r.family ?? "—").trim() || "—";
    const f = familyMap.get(fkey) ?? { sales: 0, target: 0 };
    f.sales += sales;
    f.target += target;
    familyMap.set(fkey, f);
  }

  const monthly = Array.from(monthMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, m]) => ({ month, sales: m.sales, target: m.target, achievementPct: achievement(m.sales, m.target) }));
  const topProducts = Array.from(productMap.entries())
    .map(([product, p]) => ({ product, family: p.family, sales: p.sales, target: p.target, achievementPct: achievement(p.sales, p.target) }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 6);
  const byFamily = Array.from(familyMap.entries())
    .map(([family, f]) => ({ family, sales: f.sales, target: f.target, achievementPct: achievement(f.sales, f.target) }))
    .sort((a, b) => b.sales - a.sales);

  const overallAchv = achievement(totalSales, totalTarget);
  const monthsHitTarget = monthly.filter((m) => (m.achievementPct ?? 0) >= 100).length;
  const growthPct = monthly.length > 1 && monthly[0].sales > 0 ? ((monthly[monthly.length - 1].sales - monthly[0].sales) / monthly[0].sales) * 100 : null;
  const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const top = topProducts[0];
  const teamPrefix = isTeamRollup ? `Team roll-up (${contributingReps.size} rep${contributingReps.size === 1 ? "" : "s"}): ` : "";
  const summaryText =
    rows.length === 0
      ? "No validated sales records for this employee yet (only ~2/3 of reps have linked sales)."
      : teamPrefix +
        `${overallAchv == null ? "—" : Math.round(overallAchv)}% of target (${compact(totalSales)} / ${compact(totalTarget)}) across ${monthly.length} month(s), ` +
        `hitting target in ${monthsHitTarget}. ` +
        (top ? `Led by ${top.product} (${top.achievementPct == null ? "—" : Math.round(top.achievementPct)}%). ` : "") +
        (growthPct != null ? `${growthPct >= 0 ? "+" : ""}${Math.round(growthPct)}% vs the first month.` : "");

  return {
    hasData: rows.length > 0,
    totalSales,
    totalTarget,
    achievementPct: overallAchv,
    latestMonth: monthly.length ? monthly[monthly.length - 1].month : null,
    monthsCount: monthly.length,
    monthsHitTarget,
    growthPct,
    salesPerVisit: null,
    salesPerCustomer: null,
    monthly,
    topProducts,
    byFamily,
    isTeamRollup,
    teamRepCount: contributingReps.size,
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

async function getEmployeeCoaching(hrId: string, nameByHrId: Map<string, string>): Promise<CoachingSummary> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("coaching_reports")
    .select("id,coaching_date,final_score_percent,performance_zone,actual_score,max_score,coach_hr_id,area_of_development,strength_points")
    .in("medical_rep_hr_id", hrIdLookupKeys(hrId))
    .limit(500);
  if (error) throw new Error(`Employee 360 coaching: ${error.message}`);
  const allRows = (data ?? []) as CoachingReportRow[];

  const today = new Date().toISOString().slice(0, 10);
  const rows = allRows.filter((r) => r.coaching_date && r.coaching_date <= today);
  const futureDatedExcluded = allRows.length - rows.length;
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
  const { data: itemData, error: itemError } = await supabase
    .from("coaching_score_items")
    .select("report_id,parameter_category,score_item_key,score_item_label,score")
    .in("report_id", reportIds)
    .limit(5000);
  if (itemError) throw new Error(`Employee 360 coaching items: ${itemError.message}`);
  const items = (itemData ?? []) as CoachingItemRow[];

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
  isTrainingManager: boolean;
  kind: "Regular" | "Campaign" | "Other";
  ampm: string | null;
  customerName: string | null;
};
export type DoubleVisitor = { hrId: string; name: string | null; count: number; isTrainingManager: boolean };
export type DoubleVisitHistory = {
  totalReceived: number;
  tmCount: number;
  distinctVisitors: number;
  byVisitor: DoubleVisitor[];
  events: DoubleVisitEvent[];
};

function buildDoubleVisitHistory(visits: VisitRow[], tmIds: Set<string>, nameByHrId: Map<string, string>): DoubleVisitHistory {
  const events: DoubleVisitEvent[] = [];
  const byVisitor = new Map<string, { name: string | null; count: number; isTm: boolean }>();
  for (const v of visits) {
    if (!v.double_hr_id || !v.visit_date) continue;
    const key = String(v.double_hr_id).trim().toLowerCase();
    const isTm = tmIds.has(key);
    const name = v.double_name ?? nameByHrId.get(key) ?? null;
    const visitBucket = classifyVisit(v.visit_type, v.comment, v.visit_type_description).bucket;
    const kind = visitBucket === "regular" ? "Regular" : visitBucket === "campaign" ? "Campaign" : "Other";
    events.push({
      date: v.visit_date,
      doubleHrId: v.double_hr_id,
      doubleName: name,
      isTrainingManager: isTm,
      kind,
      ampm: v.ampm,
      customerName: v.contact_name ?? v.customer_name ?? null,
    });
    const agg = byVisitor.get(key) ?? { name, count: 0, isTm };
    agg.count += 1;
    byVisitor.set(key, agg);
  }
  events.sort((a, b) => b.date.localeCompare(a.date));
  const visitorList: DoubleVisitor[] = Array.from(byVisitor.entries())
    .map(([hrId, a]) => ({ hrId, name: a.name, count: a.count, isTrainingManager: a.isTm }))
    .sort((a, b) => b.count - a.count);

  return {
    totalReceived: events.length,
    tmCount: events.filter((e) => e.isTrainingManager).length,
    distinctVisitors: visitorList.length,
    byVisitor: visitorList.slice(0, 10),
    events: events.slice(0, 40),
  };
}

// ── Before/after impact ──────────────────────────────────────────────────────
export type ImpactMetrics = { visitsPerActiveDay: number | null; campaignShare: number | null; distinctCustomers: number; sampleDays: number; sampleVisits: number };
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
    distinctCustomers: customers.size,
    sampleDays: days.size,
    sampleVisits: inRange.length,
  };
}

function meanNullable(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null);
  return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}

function poolImpact(rows: ProductiveRow[], eventDates: string[], windowDays: number): ImpactSet {
  const dates = Array.from(new Set(eventDates)).sort();
  const beforeList: ImpactMetrics[] = [];
  const afterList: ImpactMetrics[] = [];
  for (const d of dates) {
    beforeList.push(metricsInRange(rows, addDays(d, -windowDays), addDays(d, -1)));
    afterList.push(metricsInRange(rows, addDays(d, 1), addDays(d, windowDays)));
  }
  const fold = (list: ImpactMetrics[]): ImpactMetrics => ({
    visitsPerActiveDay: meanNullable(list.map((m) => m.visitsPerActiveDay)),
    campaignShare: meanNullable(list.map((m) => m.campaignShare)),
    distinctCustomers: Math.round(meanNullable(list.map((m) => m.distinctCustomers)) ?? 0),
    sampleDays: list.reduce((s, m) => s + m.sampleDays, 0),
    sampleVisits: list.reduce((s, m) => s + m.sampleVisits, 0),
  });
  return { eventCount: dates.length, windowDays, before: fold(beforeList), after: fold(afterList) };
}

// ── Expenses & Outstation ────────────────────────────────────────────────────
// Real expense history lives in outstation_expenses (Excel-imported). The newer
// GPS/variance/fraud outstation_expense_requests system is barely populated yet,
// so it is folded in as a secondary "system-submitted" enrichment when present.
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
  windowSalesValue: number | null; // period-matched sales, for the ratio
  expenseToSalesPct: number | null; // expense as % of window sales
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
  pmWorkload: number;
  summaryText: string;
};
export type OutstationSummary = {
  hasData: boolean;
  tripCount: number;
  claimedTotal: number;
  expectedTotal: number;
  varianceTotal: number;
  overClaimCount: number;
  flaggedCount: number;
};
export type EmployeeExpenses = { payroll: ExpenseSummary; outstation: OutstationSummary };

type PayrollExpenseRow = {
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
  km: number | null;
  status: string | null;
  hr_approved: boolean | null;
  am_workload: number | null;
  pm_workload: number | null;
};
type OutstationRow = {
  claimed_total_amount: number | null;
  expected_total_amount: number | null;
  variance_amount: number | null;
  eligibility_status: string | null;
  territory_validation_status: string | null;
  fraud_flags_json: unknown;
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
      pmWorkload: 0,
      summaryText: "No expense or outstation records for this employee in this period.",
    },
    outstation: {
      hasData: false,
      tripCount: 0,
      claimedTotal: 0,
      expectedTotal: 0,
      varianceTotal: 0,
      overClaimCount: 0,
      flaggedCount: 0,
    },
  };
}

async function getEmployeeExpenses(hrId: string, window: Employee360Window): Promise<EmployeeExpenses> {
  const supabase = getSupabaseAdmin();
  const keys = hrIdLookupKeys(hrId);

  const [payrollRes, outstationRes] = await Promise.all([
    supabase
      .from("outstation_expenses")
      .select("expense_date,request_type,to_location,location,from_location,description,transportation_type,travel_cost,meeting_amount,allowance,other_amount,total,km,status,hr_approved,am_workload,pm_workload")
      .in("hr_id", keys)
      .gte("expense_date", window.from)
      .lte("expense_date", window.to)
      .limit(5000),
    supabase
      .from("outstation_expense_requests")
      .select("claimed_total_amount,expected_total_amount,variance_amount,eligibility_status,territory_validation_status,fraud_flags_json")
      .in("employee_hr_id", keys)
      .gte("trip_start_date", window.from)
      .lte("trip_start_date", `${window.to} 23:59:59+00`)
      .limit(2000),
  ]);
  if (payrollRes.error) throw new Error(`Employee 360 expenses: ${payrollRes.error.message}`);
  if (outstationRes.error) throw new Error(`Employee 360 outstation: ${outstationRes.error.message}`);
  const rows = (payrollRes.data ?? []) as PayrollExpenseRow[];
  const outRows = (outstationRes.data ?? []) as OutstationRow[];

  // ---- payroll expenses ----
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
  let pmWorkload = 0;
  let noDestinationCount = 0;
  const destMap = new Map<string, { cost: number; trips: number }>();
  const monthMap = new Map<string, { cost: number; trips: number }>();
  const transportMap = new Map<string, { cost: number; trips: number }>();
  const typeMap = new Map<"Travel" | "Meeting" | "Other", { trips: number; cost: number }>();
  const trips: ExpenseTrip[] = [];
  const unresolved: ExpenseTrip[] = [];

  for (const r of rows) {
    const t = Number(r.total ?? 0);
    totalCost += t;
    travel += Number(r.travel_cost ?? 0);
    allowance += Number(r.allowance ?? 0);
    meeting += Number(r.meeting_amount ?? 0);
    other += Number(r.other_amount ?? 0);
    totalKm += Number(r.km ?? 0);
    amWorkload += Number(r.am_workload ?? 0);
    pmWorkload += Number(r.pm_workload ?? 0);
    // Approval state comes from `status` (Approved / Rejected / blank=pending).
    const st = String(r.status ?? "").trim().toLowerCase();
    if (st === "approved") {
      approvedCount += 1;
      approvedCost += t;
    } else if (st === "rejected") {
      rejectedCount += 1;
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

  const tripCount = rows.length;
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
  const summaryText =
    tripCount === 0
      ? "No expense or outstation records for this employee in this period."
      : `${tripCount} expense${tripCount === 1 ? "" : "s"} (${typeBreakdown}) costing ${compactMoney(totalCost)}. ` +
        (topCat ? `Biggest bucket: ${topCat.label.toLowerCase()} ${compactMoney(topCat.amount)} (${Math.round(topCat.pct * 100)}%). ` : "") +
        (topDest ? `Top destination ${topDest.name} (${topDest.trips} trips, ${compactMoney(topDest.cost)}). ` : "") +
        `${approvedCount} of ${tripCount} approved.`;

  const payroll: ExpenseSummary = {
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
    pmWorkload,
    summaryText,
  };

  // ---- outstation (system-submitted, GPS/variance/fraud) ----
  let claimedTotal = 0;
  let expectedTotal = 0;
  let varianceTotal = 0;
  let overClaimCount = 0;
  let flaggedCount = 0;
  for (const o of outRows) {
    claimedTotal += Number(o.claimed_total_amount ?? 0);
    expectedTotal += Number(o.expected_total_amount ?? 0);
    const v = Number(o.variance_amount ?? 0);
    varianceTotal += v;
    if (v > 0) overClaimCount += 1;
    const flags = Array.isArray(o.fraud_flags_json) ? o.fraud_flags_json.length : 0;
    const eligIssue = o.eligibility_status != null && o.eligibility_status !== "eligible";
    const territoryIssue = o.territory_validation_status != null && o.territory_validation_status !== "valid";
    if (flags > 0 || eligIssue || territoryIssue) flaggedCount += 1;
  }
  const outstation: OutstationSummary = {
    hasData: outRows.length > 0,
    tripCount: outRows.length,
    claimedTotal,
    expectedTotal,
    varianceTotal,
    overClaimCount,
    flaggedCount,
  };

  return { payroll, outstation };
}

// ── Training-manager identity ────────────────────────────────────────────────
async function getTrainingManagerHrIds(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,job_title")
    .ilike("job_title", "%training%");
  if (error) throw new Error(`Employee 360 TM lookup: ${error.message}`);
  const set = new Set<string>();
  for (const row of (data ?? []) as { hr_id: string | null }[]) {
    if (row.hr_id) set.add(String(row.hr_id).trim().toLowerCase());
  }
  return set;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export type Employee360Profile = Employee360Summary & {
  sales: SalesSummary;
  coaching: CoachingSummary;
  doubleVisits: DoubleVisitHistory;
  impact: InterventionImpact;
  expenses: EmployeeExpenses;
};

export async function getEmployee360Profile(
  hrId: string,
  nameByHrId: Map<string, string>,
  window: Employee360Window = defaultWindow(),
  teamHrIds: string[] = [hrId],
  includeExpenses: boolean = true,
  viewerRole: PhoenixRole = "Employee",
): Promise<Employee360Profile> {
  const salesTeam = teamHrIds.length ? teamHrIds : [hrId];
  const [visits, checkins, sales, tmIds, expenses] = await Promise.all([
    fetchVisitRows(hrId, window),
    fetchCheckinRows(hrId, window),
    getEmployeeSales(salesTeam, viewerRole),
    getTrainingManagerHrIds(),
    includeExpenses ? getEmployeeExpenses(hrId, window) : Promise.resolve(emptyEmployeeExpenses()),
  ]);
  const coaching = await getEmployeeCoaching(hrId, nameByHrId);

  const visitSummary = summarizeVisits(visits, window);
  const checkinSummary = summarizeCheckins(checkins, visits, visitSummary);
  const doubleVisits = buildDoubleVisitHistory(visits, tmIds, nameByHrId);

  // sales efficiency needs the visit context
  sales.salesPerVisit = visitSummary.productiveVisits > 0 ? sales.totalSales / visitSummary.productiveVisits : null;
  sales.salesPerCustomer = visitSummary.distinctCustomers > 0 ? sales.totalSales / visitSummary.distinctCustomers : null;

  // expense efficiency (cross-domain): cost per visit + expense as % of period-matched sales
  const fromMonth = window.from.slice(0, 7);
  const toMonth = window.to.slice(0, 7);
  const windowSalesValue = sales.monthly.filter((m) => m.month >= fromMonth && m.month <= toMonth).reduce((s, m) => s + m.sales, 0);
  const ep = expenses.payroll;
  ep.costPerVisit = visitSummary.productiveVisits > 0 ? ep.totalCost / visitSummary.productiveVisits : null;
  const tripVisits = ep.amWorkload + ep.pmWorkload;
  ep.costPerTripVisit = tripVisits > 0 ? ep.totalCost / tripVisits : null;
  ep.windowSalesValue = windowSalesValue > 0 ? windowSalesValue : null;
  ep.expenseToSalesPct = windowSalesValue > 0 ? (ep.totalCost / windowSalesValue) * 100 : null;

  // productive rows for the impact engine
  const productiveRows: ProductiveRow[] = visits
    .filter((v) => isProductiveVisit(v) && v.visit_date)
    .map((v) => ({
      date: v.visit_date as string,
      isCampaign: v.visit_type === CAMPAIGN_TYPE,
      customer: v.contact_crm_id != null ? `id:${v.contact_crm_id}` : (v.contact_name ?? v.customer_name ?? "").trim().toLowerCase(),
    }));

  const coachingDates = coaching.reports.map((r) => r.date);
  // Use the FULL visit set for TM dates (doubleVisits.events is capped for display).
  const tmDvDates = visits
    .filter((v) => v.double_hr_id && v.visit_date && tmIds.has(String(v.double_hr_id).trim().toLowerCase()))
    .map((v) => v.visit_date as string);

  const impact: InterventionImpact = {
    windowDays: IMPACT_WINDOW_DAYS,
    coaching: poolImpact(productiveRows, coachingDates, IMPACT_WINDOW_DAYS),
    trainingDv: poolImpact(productiveRows, tmDvDates, IMPACT_WINDOW_DAYS),
  };

  return {
    hrId,
    window,
    benchmarks: EMPLOYEE_360_BENCHMARKS,
    isMapped: visits.length > 0,
    ...visitSummary,
    ...checkinSummary,
    sales,
    coaching,
    doubleVisits,
    impact,
    expenses,
  };
}
