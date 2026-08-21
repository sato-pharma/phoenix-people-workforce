// Employee 360 — per-employee visit + check-in analytics (modules A/B).
//
// Server-only. Reads live from `ireports360_visits` and `ireports360_checkins`
// scoped to a SINGLE agent_hr_id within a date window (small per-rep queries,
// no rollup needed for v1). Exposes fetchers + pure analyzers so the deep profile
// (sales/coaching/DV/impact, deep-service.ts) reuses the same visit rows.
//
// Grounding facts encoded here (from the production audit):
//  - Visit rows carry NO real clock-time; only the AM/PM flag is intra-day. Real
//    time-of-day comes only from check-ins (`check_date`, a timestamptz).
//  - Productive visits = visit_type ∈ {0 Regular, -8 Campaign}. Everything else
//    (Meeting -11, Vacation -4, Training -9, …) is admin/non-visit and is bucketed
//    explicitly — NEVER defaulted to campaign.
//  - agent_hr_id casing is inconsistent in the CRM feed; the CRM read door matches it
//    case-insensitively, so callers pass the raw hr id.
//  - Field-force work week (owner-confirmed, matches the CRM data): Sat–Wed are
//    full working days, Thursday is AM-only (half day), Friday is off. Saturday
//    IS a working day. Only Friday is excluded from working-days (utilization);
//    the day-of-week charts dim Friday and lighten Thursday.

import { isCrmDoubleVisitRow, queryCheckins, queryVisits } from "@/lib/crm/reads";
import { classifyVisit } from "@/lib/crm/visit-types";
import {
  COMPANY_CAMPAIGN_SHARE_BY_MONTH,
  COMPANY_CHECKIN_HOUR_SHARE,
  EMPLOYEE_360_BENCHMARKS,
  LATE_NIGHT_HOURS,
} from "./benchmarks";

// The iReports360 visit-type codes, and the classifier that turns one into a label
// + counting bucket, now live in the CRM domain (src/lib/crm/visit-types.ts) so the
// CRM master, the employee portal and the NSM compliance board resolve a code the
// same way Activity Mix always has. Re-exported here unchanged because the deep
// profile and the Employee 360 tests have always imported them from this module.
export {
  ADMIN_WORK_TYPE,
  AMBIGUOUS_TYPE,
  BRM_TYPE,
  CAMPAIGN_TYPE,
  CASUAL_LEAVE_TYPE,
  HOLIDAY_TYPE,
  MEETING_TYPE,
  REGULAR_TYPE,
  TRAINING_TYPE,
  UNLABELED_FIELD_VISIT_TYPE,
  classifyVisit,
} from "@/lib/crm/visit-types";
export type { VisitBucket, VisitClassification } from "@/lib/crm/visit-types";

export type Employee360Window = { from: string; to: string; label: string };

export type VisitRow = {
  visit_type: number | null;
  visit_type_description: string | null;
  visit_date: string | null;
  ampm: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  customer_name: string | null;
  // `double_crm_id` is the raw CRM partner id — the canonical double-visit signal
  // (see isCrmDoubleVisitRow). `double_hr_id` is only the resolved employee id and
  // may be null even when a real partner rode along, so it must NOT gate DV counts.
  double_crm_id: number | null;
  double_hr_id: string | null;
  double_name: string | null;
  comment: string | null;
};

// Shared "does this row count as a productive visit" check for callers that only
// need the yes/no answer (checkin coverage, the impact engine, etc.) — always
// goes through classifyVisit so it can never drift from the Activity Mix logic.
export function isProductiveVisit(row: Pick<VisitRow, "visit_type" | "comment" | "visit_type_description">): boolean {
  const { bucket } = classifyVisit(row.visit_type, row.comment, row.visit_type_description);
  return bucket === "regular" || bucket === "campaign";
}

export type CheckinRow = { check_date: string | null; lat: number | null; lon: number | null };

export type MonthlyVisitPoint = {
  month: string;
  regular: number;
  campaign: number;
  campaignShare: number | null;
  companyCampaignShare: number | null;
};

export type LabeledCount = { label: string; count: number; pct: number };
export type NamedCount = { name: string; count: number };

export type VisitSummary = {
  productiveVisits: number;
  regularVisits: number;
  campaignVisits: number;
  trainingVisits: number;
  adminVisits: number;
  regularShare: number | null;
  campaignShare: number | null;
  campaignBalanceFlag: "healthy" | "campaign_starved" | "regular_neglect" | "no_data";
  activeDays: number;
  visitsPerActiveDay: number | null;
  distinctCustomers: number;
  doublesReceived: number;
  singleVisits: number;
  amVisits: number;
  pmVisits: number;
  unknownAmpm: number;
  monthly: MonthlyVisitPoint[];
  // deep analytics
  activityMix: LabeledCount[];
  last30: number;
  prev30: number;
  last90: number;
  momentumTrend: "up" | "down" | "flat";
  avgVisitsPerCustomer: number | null;
  repeatCustomers: number;
  oneTimeCustomers: number;
  topCustomers: NamedCount[];
  visitDayOfWeek: number[]; // 0=Sun … 6=Sat, productive-visit counts (distinct from the check-in dayOfWeek)
  workingDaysInWindow: number;
  utilization: number | null;
  visitsSummaryText: string;
};

export type CheckinSummary = {
  hasGpsCheckins: boolean;
  checkinCount: number;
  distinctCheckinDays: number;
  checkinToVisitRatio: number | null;
  checkinCoverage: number | null;
  hourHistogram: number[];
  companyHourShare: readonly number[];
  lateNightShare: number | null;
  // deep analytics
  avgFirstHour: number | null;
  avgLastHour: number | null;
  avgSpanHours: number | null;
  checkinsPerActiveDay: number | null;
  checkinDayOfWeek: number[]; // 0=Sun … 6=Sat, GPS check-in counts (distinct from the visit dayOfWeek)
  coverageTrend: { month: string; coverage: number | null }[];
  uncorroboratedDays: number;
  distinctLocations: number;
  checkinSummaryText: string;
};

export type Employee360Summary = VisitSummary &
  CheckinSummary & {
    hrId: string;
    window: Employee360Window;
    benchmarks: typeof EMPLOYEE_360_BENCHMARKS;
    isMapped: boolean;
  };

export function defaultWindow(): Employee360Window {
  const now = new Date();
  const year = now.getUTCFullYear();
  const to = now.toISOString().slice(0, 10);
  return { from: `${year}-01-01`, to, label: `${year} year-to-date` };
}

export async function fetchVisitRows(hrId: string, window: Employee360Window): Promise<VisitRow[]> {
  return queryVisits<VisitRow>({
    // The CRM read door matches hr ids case-insensitively — pass the raw id.
    agentHrIds: [hrId],
    dateFrom: window.from,
    dateTo: window.to,
    columns: "visit_type,visit_type_description,visit_date,ampm,contact_crm_id,contact_name,customer_name,double_crm_id,double_hr_id,double_name,comment",
    // Collapse iReports360 burst-duplicate double-visit re-saves so "doubles received" (summary
    // card) and the double-visit history aren't inflated. No-op for single visits, so the rest of
    // the activity mix is unchanged.
    collapseDoubleVisits: true,
  });
}

export async function fetchCheckinRows(hrId: string, window: Employee360Window): Promise<CheckinRow[]> {
  return queryCheckins<CheckinRow>({
    agentHrIds: [hrId],
    dateFrom: window.from,
    dateTo: window.to,
    columns: "check_date,lat,lon",
  });
}

// check_date is a zone-less Cairo wall-clock stored verbatim as +00, so its clock reading is
// ALREADY Cairo-local — read day + hour as-is with timeZone "UTC". Converting through Africa/Cairo
// would double-add the Egypt offset and push the whole check-in histogram / late-night tail 2–3h late.
function cairoParts(iso: string): { day: string; hourDecimal: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const [h, m] = hm.split(":").map((v) => Number(v));
  return { day, hourDecimal: (h % 24) + (Number.isFinite(m) ? m / 60 : 0) };
}

export function cairoHour(iso: string): number {
  const parts = cairoParts(iso);
  return parts ? Math.floor(parts.hourDecimal) : -1;
}

function customerKeyOf(row: VisitRow): string {
  return row.contact_crm_id != null ? `id:${row.contact_crm_id}` : (row.contact_name ?? row.customer_name ?? "").trim().toLowerCase();
}
function customerNameOf(row: VisitRow): string {
  return (row.contact_name ?? row.customer_name ?? "").trim() || "—";
}
function dowOf(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? -1 : d.getUTCDay();
}
function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
export function countWorkingDays(from: string, to: string): number {
  let count = 0;
  let cursor = from;
  for (let i = 0; i < 400 && cursor <= to; i += 1) {
    const dow = dowOf(cursor);
    // Field-force work week: only Friday is off. Sat–Wed are full days and
    // Thursday is a working half-day (AM only) — all of them count. Saturday is
    // a WORKING day (owner-confirmed; ~16k Sat visits in production).
    if (dow !== 5) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}
function describeVs(value: number | null, benchmark: number): string {
  if (value == null || benchmark <= 0) return "—";
  const ratio = value / benchmark;
  const diff = Math.round(Math.abs(ratio - 1) * 100);
  if (diff <= 5) return "on par with the company average";
  return `${diff}% ${ratio > 1 ? "above" : "below"} the company average`;
}

export function summarizeVisits(visits: VisitRow[], window: Employee360Window): VisitSummary {
  let regularVisits = 0;
  let campaignVisits = 0;
  let trainingVisits = 0;
  let adminVisits = 0;
  let doublesReceived = 0;
  let productiveDoubles = 0;
  let amVisits = 0;
  let pmVisits = 0;
  let unknownAmpm = 0;
  const activeDaySet = new Set<string>();
  const customerCount = new Map<string, { name: string; count: number }>();
  const monthlyMap = new Map<string, { regular: number; campaign: number }>();
  const typeMix = new Map<string, number>();
  const dow = new Array<number>(7).fill(0);
  const productiveDates: string[] = [];

  for (const row of visits) {
    const type = row.visit_type;
    const { label, bucket } = classifyVisit(type, row.comment, row.visit_type_description);
    const isRegular = bucket === "regular";
    const isCampaign = bucket === "campaign";
    const isProductive = isRegular || isCampaign;

    typeMix.set(label, (typeMix.get(label) ?? 0) + 1);

    if (isRegular) regularVisits += 1;
    else if (isCampaign) campaignVisits += 1;
    else if (bucket === "training") trainingVisits += 1;
    else adminVisits += 1;

    // A double visit is a real partner (double_crm_id) on a fieldwork type {0,-8}
    // — the canonical crm/reads predicate. Do NOT count a partner riding along on
    // a Meeting/Vacation/Training row, and key on double_crm_id (raw partner), not
    // the resolved double_hr_id which can be null for a real, unmapped partner.
    if (isCrmDoubleVisitRow(row)) doublesReceived += 1;

    if (isProductive) {
      if (isCrmDoubleVisitRow(row)) productiveDoubles += 1;
      if (row.visit_date) {
        activeDaySet.add(row.visit_date);
        productiveDates.push(row.visit_date);
        const month = row.visit_date.slice(0, 7);
        const bkt = monthlyMap.get(month) ?? { regular: 0, campaign: 0 };
        if (isRegular) bkt.regular += 1;
        else bkt.campaign += 1;
        monthlyMap.set(month, bkt);
        const wd = dowOf(row.visit_date);
        if (wd >= 0) dow[wd] += 1;
      }
      const key = customerKeyOf(row);
      if (key) {
        const c = customerCount.get(key) ?? { name: customerNameOf(row), count: 0 };
        c.count += 1;
        customerCount.set(key, c);
      }
      const period = String(row.ampm ?? "").trim().toUpperCase();
      if (period === "AM") amVisits += 1;
      else if (period === "PM") pmVisits += 1;
      else unknownAmpm += 1;
    }
  }

  const productiveVisits = regularVisits + campaignVisits;
  const regularShare = productiveVisits > 0 ? regularVisits / productiveVisits : null;
  const campaignShare = productiveVisits > 0 ? campaignVisits / productiveVisits : null;
  const activeDays = activeDaySet.size;
  const visitsPerActiveDay = activeDays > 0 ? productiveVisits / activeDays : null;

  let campaignBalanceFlag: VisitSummary["campaignBalanceFlag"] = "no_data";
  if (campaignShare != null) {
    if (campaignShare < EMPLOYEE_360_BENCHMARKS.campaignShareLow) campaignBalanceFlag = "campaign_starved";
    else if (campaignShare > EMPLOYEE_360_BENCHMARKS.campaignShareHigh) campaignBalanceFlag = "regular_neglect";
    else campaignBalanceFlag = "healthy";
  }

  const monthly: MonthlyVisitPoint[] = Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, bkt]) => {
      const productive = bkt.regular + bkt.campaign;
      const companyPct = COMPANY_CAMPAIGN_SHARE_BY_MONTH[month];
      return { month, regular: bkt.regular, campaign: bkt.campaign, campaignShare: productive > 0 ? bkt.campaign / productive : null, companyCampaignShare: companyPct != null ? companyPct / 100 : null };
    });

  const activityMix: LabeledCount[] = Array.from(typeMix.entries())
    .map(([label, count]) => ({ label, count, pct: visits.length > 0 ? count / visits.length : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // momentum (relative to window end)
  const inRange = (start: string, end: string) => productiveDates.filter((d) => d >= start && d <= end).length;
  const last30 = inRange(addDays(window.to, -30), window.to);
  const prev30 = inRange(addDays(window.to, -60), addDays(window.to, -31));
  const last90 = inRange(addDays(window.to, -90), window.to);
  const momentumTrend: "up" | "down" | "flat" = last30 > prev30 * 1.1 ? "up" : last30 < prev30 * 0.9 ? "down" : "flat";

  const customers = Array.from(customerCount.values());
  const distinctCustomers = customers.length;
  const repeatCustomers = customers.filter((c) => c.count > 1).length;
  const oneTimeCustomers = distinctCustomers - repeatCustomers;
  const avgVisitsPerCustomer = distinctCustomers > 0 ? productiveVisits / distinctCustomers : null;
  const topCustomers = customers
    .filter((c) => c.name !== "—")
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((c) => ({ name: c.name, count: c.count }));

  const workingDaysInWindow = countWorkingDays(window.from, window.to);
  const utilization = workingDaysInWindow > 0 ? activeDays / workingDaysInWindow : null;

  const b = EMPLOYEE_360_BENCHMARKS;
  const balanceLabel = campaignBalanceFlag === "healthy" ? "a balanced mix" : campaignBalanceFlag === "campaign_starved" ? "campaign-starved" : campaignBalanceFlag === "regular_neglect" ? "regular-neglect" : "no data";
  const summaryText =
    productiveVisits === 0
      ? "No productive visits recorded in this window."
      : `${productiveVisits.toLocaleString()} productive visits over ${activeDays} active days ` +
        `(${visitsPerActiveDay?.toFixed(1)}/day, ${describeVs(visitsPerActiveDay, b.visitsPerActiveDay)}). ` +
        `Mix is ${Math.round((regularShare ?? 0) * 100)}% regular / ${Math.round((campaignShare ?? 0) * 100)}% campaign — ${balanceLabel}. ` +
        `Reaches ${distinctCustomers} customers (${avgVisitsPerCustomer?.toFixed(1)} visits each); ${repeatCustomers} seen more than once. ` +
        `Momentum is ${momentumTrend} (last 30d: ${last30} vs prior 30d: ${prev30}).`;

  return {
    productiveVisits,
    regularVisits,
    campaignVisits,
    trainingVisits,
    adminVisits,
    regularShare,
    campaignShare,
    campaignBalanceFlag,
    activeDays,
    visitsPerActiveDay,
    distinctCustomers,
    doublesReceived,
    singleVisits: productiveVisits - productiveDoubles,
    amVisits,
    pmVisits,
    unknownAmpm,
    monthly,
    activityMix,
    last30,
    prev30,
    last90,
    momentumTrend,
    avgVisitsPerCustomer,
    repeatCustomers,
    oneTimeCustomers,
    topCustomers,
    visitDayOfWeek: dow,
    workingDaysInWindow,
    utilization,
    visitsSummaryText: summaryText,
  };
}

export function summarizeCheckins(checkins: CheckinRow[], visits: VisitRow[], visitSummary: VisitSummary): CheckinSummary {
  const hourHistogram = new Array<number>(24).fill(0);
  const dow = new Array<number>(7).fill(0);
  const perDay = new Map<string, { first: number; last: number }>();
  const monthDays = new Map<string, Set<string>>();
  const locations = new Set<string>();
  let lateNight = 0;

  for (const row of checkins) {
    if (!row.check_date) continue;
    const parts = cairoParts(row.check_date);
    if (!parts) continue;
    const hour = Math.floor(parts.hourDecimal);
    if (hour >= 0 && hour < 24) {
      hourHistogram[hour] += 1;
      if (LATE_NIGHT_HOURS.includes(hour)) lateNight += 1;
    }
    const wd = dowOf(parts.day);
    if (wd >= 0) dow[wd] += 1;
    const span = perDay.get(parts.day) ?? { first: parts.hourDecimal, last: parts.hourDecimal };
    span.first = Math.min(span.first, parts.hourDecimal);
    span.last = Math.max(span.last, parts.hourDecimal);
    perDay.set(parts.day, span);
    const month = parts.day.slice(0, 7);
    const set = monthDays.get(month) ?? new Set<string>();
    set.add(parts.day);
    monthDays.set(month, set);
    if (row.lat != null && row.lon != null) locations.add(`${row.lat.toFixed(3)},${row.lon.toFixed(3)}`);
  }

  const checkinCount = checkins.length;
  const distinctCheckinDays = perDay.size;

  // work-hours span (avg first / last / span across days)
  const firsts: number[] = [];
  const lasts: number[] = [];
  perDay.forEach((v) => {
    firsts.push(v.first);
    lasts.push(v.last);
  });
  const mean = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  const avgFirstHour = mean(firsts);
  const avgLastHour = mean(lasts);
  const avgSpanHours = avgFirstHour != null && avgLastHour != null ? avgLastHour - avgFirstHour : null;

  const activeDaysByMonth = new Map<string, Set<string>>();
  const gpsDays = new Set(perDay.keys());
  const visitDays = new Set<string>();
  for (const v of visits) {
    if (isProductiveVisit(v) && v.visit_date) {
      visitDays.add(v.visit_date);
      const m = v.visit_date.slice(0, 7);
      const s = activeDaysByMonth.get(m) ?? new Set<string>();
      s.add(v.visit_date);
      activeDaysByMonth.set(m, s);
    }
  }

  // Coverage is "how many of your ACTIVE days carry a GPS check-in", so both sides of the ratio
  // count the same days. Dividing every GPS day by active days mixed two populations: a check-in
  // logged on a day with no productive visit pushed the share past 100% for 6 of the 92 live reps,
  // one of them to 150%, which reads as better-than-perfect corroboration.
  const corroboratedDays = new Set(Array.from(visitDays).filter((day) => gpsDays.has(day)));
  const uncorroboratedDays = visitDays.size - corroboratedDays.size;

  // per-month coverage trend (corroborated active days ÷ productive active days)
  const months = Array.from(new Set([...activeDaysByMonth.keys(), ...monthDays.keys()])).sort();
  const coverageTrend = months.map((month) => {
    const active = activeDaysByMonth.get(month) ?? new Set<string>();
    const corroborated = Array.from(active).filter((day) => gpsDays.has(day)).length;
    return { month, coverage: active.size > 0 ? corroborated / active.size : null };
  });

  const fmtHour = (h: number | null) => {
    if (h == null) return "—";
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  const coverage = visitSummary.activeDays > 0 ? corroboratedDays.size / visitSummary.activeDays : null;
  const summaryText =
    checkinCount === 0
      ? "No GPS check-ins were logged — timing and authenticity cannot be assessed (usually the mobile app GPS is off)."
      : `${checkinCount.toLocaleString()} GPS check-ins across ${distinctCheckinDays} days (${Math.round((coverage ?? 0) * 100)}% of active days corroborated). ` +
        `Typical field window ${fmtHour(avgFirstHour)}–${fmtHour(avgLastHour)} (~${avgSpanHours?.toFixed(1)}h). ` +
        `${uncorroboratedDays} visit day(s) had no GPS. ${locations.size} distinct locations; ` +
        `${Math.round((lateNight / checkinCount) * 100)}% of check-ins fall after 22:00.`;

  return {
    hasGpsCheckins: checkinCount > 0,
    checkinCount,
    distinctCheckinDays,
    checkinToVisitRatio: visitSummary.productiveVisits > 0 ? checkinCount / visitSummary.productiveVisits : null,
    checkinCoverage: coverage,
    hourHistogram,
    companyHourShare: COMPANY_CHECKIN_HOUR_SHARE,
    lateNightShare: checkinCount > 0 ? lateNight / checkinCount : null,
    avgFirstHour,
    avgLastHour,
    avgSpanHours,
    checkinsPerActiveDay: distinctCheckinDays > 0 ? checkinCount / distinctCheckinDays : null,
    checkinDayOfWeek: dow,
    coverageTrend,
    uncorroboratedDays,
    distinctLocations: locations.size,
    checkinSummaryText: summaryText,
  };
}

export async function getEmployee360Summary(hrId: string, window: Employee360Window = defaultWindow()): Promise<Employee360Summary> {
  const [visits, checkins] = await Promise.all([fetchVisitRows(hrId, window), fetchCheckinRows(hrId, window)]);
  const visitSummary = summarizeVisits(visits, window);
  const checkinSummary = summarizeCheckins(checkins, visits, visitSummary);
  return { hrId, window, benchmarks: EMPLOYEE_360_BENCHMARKS, isMapped: visits.length > 0, ...visitSummary, ...checkinSummary };
}
