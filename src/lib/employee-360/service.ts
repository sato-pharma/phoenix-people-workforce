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
//  - agent_hr_id casing is inconsistent in the CRM feed; match via hrIdLookupKeys.
//  - Field-force work week (owner-confirmed, matches the CRM data): Sat–Wed are
//    full working days, Thursday is AM-only (half day), Friday is off. Saturday
//    IS a working day. Only Friday is excluded from working-days (utilization);
//    the day-of-week charts dim Friday and lighten Thursday.

import { queryCheckins, queryVisits } from "@/lib/crm/reads";
import { hrIdLookupKeys } from "@/lib/hr-id";
import {
  COMPANY_CAMPAIGN_SHARE_BY_MONTH,
  COMPANY_CHECKIN_HOUR_SHARE,
  EMPLOYEE_360_BENCHMARKS,
  LATE_NIGHT_HOURS,
} from "./benchmarks";

export const REGULAR_TYPE = 0;
export const CAMPAIGN_TYPE = -8;
export const TRAINING_TYPE = -9;

// Additional iReports360 visit-type codes that come back from the CRM's own API
// with the literal description "Unknown" (confirmed against production comment
// text with the business owner, 2026-07-14 — see PR #1061). Each was identified
// by reading the actual `comment` field on hundreds of sample rows, not guessed.
export const HOLIDAY_TYPE = -5;
export const CASUAL_LEAVE_TYPE = -6;
export const AMBIGUOUS_TYPE = -7; // split at runtime by comment text — see classifyAmbiguousComment
export const MEETING_TYPE = -19;
export const ADMIN_WORK_TYPE = -20;
export const BRM_TYPE = -21;
// Real field visits (doctor/pharmacy call notes) that iReports360 never assigned
// a description to. Counted as productive, same as REGULAR_TYPE ("put it in its
// normal place") — pharmacy-flavored comments get their own distinct label.
export const UNLABELED_FIELD_VISIT_TYPE = -30;

export type Employee360Window = { from: string; to: string; label: string };

export type VisitRow = {
  visit_type: number | null;
  visit_type_description: string | null;
  visit_date: string | null;
  ampm: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  customer_name: string | null;
  double_hr_id: string | null;
  double_name: string | null;
  comment: string | null;
};

export type VisitBucket = "regular" | "campaign" | "training" | "admin";
export type VisitClassification = { label: string; bucket: VisitBucket };

// -7's own comments carry no single consistent meaning (owner-confirmed) — read
// the free-text comment itself to route it: "sales day" -> Health Day, a leave
// mention -> Vacations & Leaves, a meeting mention -> Meetings. Anything else
// falls back to Admin Work (no clearer signal available in the text).
function classifyAmbiguousComment(comment: string | null): string {
  const c = (comment ?? "").toLowerCase();
  if (c.includes("sales day") || c.includes("health day")) return "Health Day";
  if (c.includes("اجازه") || c.includes("اجازة") || c.includes("excuse") || c.includes("leave")) return "Vacations & Leaves";
  if (c.includes("meeting") || c.includes("اجتماع")) return "Meetings";
  return "Admin Work";
}

// "ص" (short for صيدلية/pharmacy) as its own token before a name is the reps'
// own shorthand for a pharmacy call (e.g. "ص السلامه", "ص. نور الرحمن"), seen
// consistently across -30 sample comments alongside "فارما"/"pharmacy". Best
// effort against free text — not perfect, but never fabricates a category.
const PHARMACY_COMMENT_PATTERN = /(^|\s)ص[\s.]|صيدلي|فارما|pharmacy/iu;
function isPharmacyComment(comment: string | null): boolean {
  return PHARMACY_COMMENT_PATTERN.test(comment ?? "");
}

// Single source of truth for "what is this visit" — both its display label
// (Activity Mix) and which counting bucket it belongs to (productive/admin/etc).
// Every place that used to compare visit_type directly must go through this
// so the two can never drift apart again.
export function classifyVisit(type: number | null, comment: string | null, rawDescription: string | null): VisitClassification {
  if (type === REGULAR_TYPE) return { label: "Regular", bucket: "regular" };
  if (type === CAMPAIGN_TYPE) return { label: "Campaign", bucket: "campaign" };
  if (type === TRAINING_TYPE) return { label: "Training", bucket: "training" };
  if (type === HOLIDAY_TYPE) return { label: "Vacations & Leaves", bucket: "admin" };
  if (type === CASUAL_LEAVE_TYPE) return { label: "Vacations & Leaves", bucket: "admin" };
  if (type === MEETING_TYPE) return { label: "Meetings", bucket: "admin" };
  if (type === ADMIN_WORK_TYPE) return { label: "Admin Work", bucket: "admin" };
  if (type === BRM_TYPE) return { label: "Business Review (BRM)", bucket: "admin" };
  if (type === AMBIGUOUS_TYPE) return { label: classifyAmbiguousComment(comment), bucket: "admin" };
  if (type === UNLABELED_FIELD_VISIT_TYPE) {
    return isPharmacyComment(comment) ? { label: "Pharmacy Visit", bucket: "regular" } : { label: "Regular", bucket: "regular" };
  }
  const trimmed = (rawDescription ?? "").trim();
  const label = trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : `Type ${type ?? "?"}`;
  return { label, bucket: "admin" };
}

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
    agentHrIds: hrIdLookupKeys(hrId),
    dateFrom: window.from,
    dateTo: window.to,
    columns: "visit_type,visit_type_description,visit_date,ampm,contact_crm_id,contact_name,customer_name,double_hr_id,double_name,comment",
  });
}

export async function fetchCheckinRows(hrId: string, window: Employee360Window): Promise<CheckinRow[]> {
  return queryCheckins<CheckinRow>({
    agentHrIds: hrIdLookupKeys(hrId),
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

    if (row.double_hr_id) doublesReceived += 1;

    if (isProductive) {
      if (row.double_hr_id) productiveDoubles += 1;
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

  // per-month coverage trend (check-in days ÷ productive active days)
  const activeDaysByMonth = new Map<string, Set<string>>();
  for (const v of visits) {
    if (isProductiveVisit(v) && v.visit_date) {
      const m = v.visit_date.slice(0, 7);
      const s = activeDaysByMonth.get(m) ?? new Set<string>();
      s.add(v.visit_date);
      activeDaysByMonth.set(m, s);
    }
  }
  const months = Array.from(new Set([...activeDaysByMonth.keys(), ...monthDays.keys()])).sort();
  const coverageTrend = months.map((month) => {
    const active = activeDaysByMonth.get(month)?.size ?? 0;
    const gps = monthDays.get(month)?.size ?? 0;
    return { month, coverage: active > 0 ? gps / active : null };
  });

  // uncorroborated: productive visit days with no GPS check-in that day
  const gpsDays = new Set(perDay.keys());
  const visitDays = new Set<string>();
  for (const v of visits) if (isProductiveVisit(v) && v.visit_date) visitDays.add(v.visit_date);
  let uncorroboratedDays = 0;
  visitDays.forEach((d) => {
    if (!gpsDays.has(d)) uncorroboratedDays += 1;
  });

  const fmtHour = (h: number | null) => {
    if (h == null) return "—";
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  const coverage = visitSummary.activeDays > 0 ? distinctCheckinDays / visitSummary.activeDays : null;
  const summaryText =
    checkinCount === 0
      ? "No GPS check-ins were logged — timing and authenticity cannot be assessed (usually the mobile app GPS is off)."
      : `${checkinCount.toLocaleString()} GPS check-ins across ${distinctCheckinDays} days (${Math.round((coverage ?? 0) * 100)}% of active days). ` +
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
