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
//  - Working days for utilization are the CALL RATE's working days (isCallRateWorkingDay,
//    owner 2026-09-05): Saturday to Wednesday, less the confirmed national holidays.
//    Thursday and Friday are not working days, so a Thursday visit is still a visit but
//    never stretches the denominator. The day-of-week charts dim Friday and lighten Thursday.

import { isCallRateWorkingDay, normalizeSession, type CallRateHolidays } from "@/lib/crm/call-rate";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import type { CrmListType } from "@/lib/crm/contacts-web-client";
import { phoenixVisitLane } from "@/lib/crm/phoenix-kpi-rules";
import { PHOENIX_VISIT_DETAIL_COLUMNS, type PhoenixVisitDetailRow } from "@/lib/crm/phoenix-visit-detail";
import { isCrmDoubleVisitRow, queryCheckins, queryVisits } from "@/lib/crm/reads";
import { addVisitToSplit, emptyVisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { classifyVisit } from "@/lib/crm/visit-types";
import { CATCH_ALL_CONTACT_CRM_ID } from "@/lib/crm/rep-kpi-reports";
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

export type VisitRow = PhoenixVisitDetailRow & {
  /** Slot 2 — a chain visit's second manager. Absent on a vendor row, which has one partner column. */
  double2_hr_id?: string | null;
  double2_name?: string | null;
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
  /** 'phoenix' on a native row, 'ireports360' on a vendor row (crm_visits_unified). */
  source?: string | null;
  /**
   * The visited contact's speciality — 'pharmacy' puts the visit under Pharmacies, never AM or PM,
   * and is the pharmacy signal for a most-visited contact on no list of the rep's.
   */
  speciality?: string | null;
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

/**
 * Where a rep's mix stands. Owner rule, 2026-09-21: 100% regular is the BEST case — the more
 * regular, the better, with no floor for campaign. Only a campaign majority is flagged.
 */
export type CampaignMixVerdict = "all_regular" | "mostly_regular" | "campaign_heavy" | "no_data";

/**
 * Which way the mix moved, from the first to the last month with productive visits. Campaign
 * falling while regular rises is the best direction ("improving"). Read on SHARES, not counts, so a
 * part month at either end of the window cannot fake a rise or a fall.
 */
export type CampaignMixTrend = {
  direction: "improving" | "worsening" | "steady";
  fromMonth: string;
  toMonth: string;
  fromCampaignShare: number;
  toCampaignShare: number;
};

export function campaignMixVerdictOf(campaignVisits: number, productiveVisits: number): CampaignMixVerdict {
  if (productiveVisits <= 0) return "no_data";
  if (campaignVisits <= 0) return "all_regular";
  return campaignVisits / productiveVisits >= EMPLOYEE_360_BENCHMARKS.campaignHeavyShare ? "campaign_heavy" : "mostly_regular";
}

export function campaignMixTrendOf(monthly: readonly MonthlyVisitPoint[]): CampaignMixTrend | null {
  const months = monthly.filter((m) => m.regular + m.campaign > 0 && m.campaignShare != null);
  if (months.length < 2) return null;
  const first = months[0];
  const last = months[months.length - 1];
  const from = first.campaignShare ?? 0;
  const to = last.campaignShare ?? 0;
  const change = to - from;
  const band = EMPLOYEE_360_BENCHMARKS.campaignTrendDeadband;
  return {
    direction: change <= -band ? "improving" : change >= band ? "worsening" : "steady",
    fromMonth: first.month,
    toMonth: last.month,
    fromCampaignShare: from,
    toCampaignShare: to,
  };
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthShort(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTH_SHORT[Number(m) - 1] ?? m} ${y}`;
}

const CAMPAIGN_MIX_WORDS: Record<CampaignMixVerdict, string> = {
  all_regular: "all regular, the best case",
  mostly_regular: "mostly regular (100% regular is the best case)",
  campaign_heavy: "campaign-heavy (more campaign than regular)",
  no_data: "no data",
};

function describeCampaignTrend(trend: CampaignMixTrend | null): string {
  if (!trend) return "";
  const from = `${Math.round(trend.fromCampaignShare * 100)}%`;
  const to = `${Math.round(trend.toCampaignShare * 100)}%`;
  const span = `${monthShort(trend.fromMonth)} to ${monthShort(trend.toMonth)}`;
  if (trend.direction === "improving") return ` Campaign fell from ${from} to ${to} (${span}) while regular rose — the best direction.`;
  if (trend.direction === "worsening") return ` Campaign rose from ${from} to ${to} (${span}) while regular fell.`;
  if (trend.toCampaignShare === 0 && trend.fromCampaignShare === 0) return ` Held at all regular from ${span}.`;
  return ` Campaign steady near ${to} (${span}).`;
}

export type LabeledCount = { label: string; count: number; pct: number };
export type NamedCount = { name: string; count: number };

/** Where a visited customer belongs: an AM doctor, a PM doctor, or a pharmacy. */
export type CustomerLane = "am" | "pm" | "pharmacy";
export const CUSTOMER_LANES: readonly CustomerLane[] = ["am", "pm", "pharmacy"];

/** Most-visited customers, one list per lane — a pharmacy is never a contact (owner rule). */
export type TopCustomersByLane = Record<CustomerLane, { customers: number; top: NamedCount[] }> & {
  /** Customers no lane could be read for (no list, no pharmacy mark, no AM/PM flag). */
  unplaced: number;
};

/** How many of each lane's most-visited customers the profile carries. */
export const TOP_CUSTOMERS_PER_LANE = 5;

/**
 * Which lane one productive visit's customer falls in. PURE.
 *
 * The rep's CURRENT list decides, through the CRM's own rule (`phoenixVisitLane`: the contact's
 * list, the visit's AM/PM flag only settling a contact carried on both). A customer on no list of
 * the rep's — an old list, a manager's own visit — falls back to the same two signals the call
 * rate reads: a pharmacy specialty (or the reps' pharmacy comment on an unlabelled visit) makes a
 * pharmacy; otherwise the visit's AM/PM flag, which production carries on all but 6 of 23,381
 * regular visits since 2026-08-01. Null only when none of that is there.
 */
export function customerLaneOf(
  row: Pick<VisitRow, "contact_crm_id" | "visit_date" | "visit_type" | "visit_type_description" | "comment" | "ampm" | "speciality">,
  listsByContact?: ReadonlyMap<number, ReadonlySet<CrmListType>>,
): CustomerLane | null {
  if (listsByContact && row.contact_crm_id != null && (listsByContact.get(row.contact_crm_id)?.size ?? 0) > 0) {
    const lane = phoenixVisitLane(
      {
        contact_crm_id: row.contact_crm_id,
        visit_date: row.visit_date,
        visit_type: row.visit_type,
        visit_type_description: row.visit_type_description,
        comment: row.comment,
        ampm: row.ampm,
        speciality: row.speciality ?? null,
        hasCheckin: false,
      },
      listsByContact,
    );
    if (lane !== "campaign") return lane;
  }
  // A Phoenix pharmacy call carries its list as `ampm = 'Pharmacy'`, often with no speciality.
  if (isPharmacyListType(row.ampm) || isPharmacySpeciality(row.speciality)) return "pharmacy";
  if (classifyVisit(row.visit_type, row.comment, row.visit_type_description).label === "Pharmacy Visit") return "pharmacy";
  const session = normalizeSession(row.ampm);
  return session === "unspecified" ? null : session;
}

export type VisitSummary = {
  productiveVisits: number;
  regularVisits: number;
  campaignVisits: number;
  trainingVisits: number;
  adminVisits: number;
  regularShare: number | null;
  campaignShare: number | null;
  campaignMix: CampaignMixVerdict;
  campaignTrend: CampaignMixTrend | null;
  activeDays: number;
  visitsPerActiveDay: number | null;
  distinctCustomers: number;
  doublesReceived: number;
  /**
   * The doubles received, one figure per kind of companion: a manager, a chain (a manager and his own
   * manager together), or a product or training manager. A Phoenix CRM row says its kind; an iReports360
   * row carries none, so it is read as a visit with a manager. The three add up to `doublesReceived`.
   */
  doublesReceivedByKind: DoublesReceivedByKind;
  /** The distinct days those double visits were made on (owner, 2026-10-27: "how many days"). */
  doublesReceivedDays: number;
  singleVisits: number;
  // THE AM · PM · PHARMACIES GOLDEN RULE (src/lib/crm/visit-count-buckets.ts): three figures
  // apart — a pharmacy visit is counted in pharmacyVisits only, never in pmVisits or amVisits.
  amVisits: number;
  pmVisits: number;
  pharmacyVisits: number;
  /**
   * How many of the three figures' visits are Phoenix CRM's own (a started team's). Phoenix CRM logs
   * no pharmacy visit, so `pharmacyVisits` counts the iReports360 visits alone and the page prints it
   * through the golden-rule helper — "Pharmacies not recorded in Phoenix", never 0. Optional: a profile
   * cached before it existed reads as none.
   */
  phoenixVisits?: number;
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
  topCustomers: TopCustomersByLane;
  visitDayOfWeek: number[]; // 0=Sun … 6=Sat, productive-visit counts (distinct from the check-in dayOfWeek)
  /** Saturday to Wednesday less the confirmed national holidays — the call rate's own working days. */
  workingDaysInWindow: number;
  /** Active days that fall on a working day, over `workingDaysInWindow`. */
  utilization: number | null;
  /**
   * False when the holiday calendar could not be read in full, so a holiday may still sit in the
   * working days. The page says so beside the figure. Absent on a summary built without a calendar.
   */
  holidaysComplete?: boolean;
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
    // `source` marks a Phoenix native row, where a partner with no CRM id is still a double visit
    // (isCrmDoubleVisitRow). Without it a new hire's confirmed double visits never count here.
    // `speciality` is the pharmacy signal: it files a visit under Pharmacies, never AM or PM, and
    // marks a most-visited customer on no list of the rep's.
    // THE PHOENIX FIELD SET. Selected unconditionally and shown only at the tier the reader earns
    // (phoenix-visit-detail.ts): a select is a string, so a list that varied by role would read
    // `undefined` and print a blank, which is indistinguishable from a visit that recorded nothing.
    columns:
      "visit_type,visit_type_description,visit_date,ampm,contact_crm_id,contact_name,customer_name," +
      "double_crm_id,double_hr_id,double_name,double2_hr_id,double2_name,comment,source,speciality," +
      PHOENIX_VISIT_DETAIL_COLUMNS.replaceAll(" ", ""),
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

/**
 * The customer a visit reached, or null when it reached no real one.
 *
 * 🔴 A CONTACT ID OF 0 IS NOBODY. Every campaign (-8) and unlabelled field visit (-30) carries
 * contact id 0 and no name — measured on production 2026-09-21: 6,623 and 320 rows since July, not
 * one with a real id. Keyed as `id:0`, all of a rep's campaign work became ONE customer: distinct
 * customers one too high, a "repeat customer" who does not exist, and visits-per-customer inflated
 * by every campaign visit. 100000 is the catch-all contact, which is no doctor either
 * (CATCH_ALL_CONTACT_CRM_ID). Both still count as productive visits — they just reach no customer.
 */
export function customerKeyOf(
  row: Pick<VisitRow, "contact_crm_id" | "contact_name" | "customer_name">,
): string | null {
  const id = row.contact_crm_id;
  if (id != null) {
    return Number.isInteger(id) && id > 0 && id !== CATCH_ALL_CONTACT_CRM_ID ? `id:${id}` : null;
  }
  return (row.contact_name ?? row.customer_name ?? "").trim().toLowerCase() || null;
}
/**
 * Sales efficiency over the visit window.
 *
 * Only the months the window touches count. A person's sales series runs from the history floor
 * (the tile says "through <month>"), so dividing the whole series by the WINDOW's visits put eight
 * months of sales over one month of visits. A team roll-up gets no ratio at all: those sales are
 * the whole team's while the visits are the manager's own, so the figure would describe nobody.
 * `windowSalesValue` is returned for the expense ratio, which is the person's cost against the
 * same months whatever the roll-up.
 */
export function windowSalesEfficiency(input: {
  monthly: ReadonlyArray<{ month: string; sales: number }>;
  window: Pick<Employee360Window, "from" | "to">;
  isTeamRollup: boolean;
  productiveVisits: number;
  distinctCustomers: number;
}): { windowSalesValue: number; salesPerVisit: number | null; salesPerCustomer: number | null } {
  const fromMonth = input.window.from.slice(0, 7);
  const toMonth = input.window.to.slice(0, 7);
  const windowSalesValue = input.monthly
    .filter((m) => m.month >= fromMonth && m.month <= toMonth)
    .reduce((s, m) => s + m.sales, 0);
  const own = !input.isTeamRollup && windowSalesValue > 0 ? windowSalesValue : null;
  return {
    windowSalesValue,
    salesPerVisit: own != null && input.productiveVisits > 0 ? own / input.productiveVisits : null,
    salesPerCustomer: own != null && input.distinctCustomers > 0 ? own / input.distinctCustomers : null,
  };
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
/**
 * The working days in the window, by the call rate's own rule (isCallRateWorkingDay): Saturday to
 * Wednesday, less the national holidays passed in. Thursday and Friday never count. Saturday DOES
 * (owner-confirmed; ~16k Saturday visits in production).
 */
export function countWorkingDays(from: string, to: string, holidays?: CallRateHolidays): number {
  let count = 0;
  let cursor = from;
  for (let i = 0; i < 400 && cursor <= to; i += 1) {
    if (isCallRateWorkingDay(cursor, holidays)) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

export type DoubleReceivedKind = "double" | "chain" | "product_manager";
export type DoublesReceivedByKind = { withManager: number; chain: number; withProductManager: number };

/**
 * Which kind of double visit a rep received. A Phoenix CRM row carries its own kind (`visit_kind`): with a
 * manager, a chain, or with a product or training manager. An iReports360 row carries no kind and only one
 * companion, so it is a visit with a manager. Pure.
 */
export function doubleReceivedKind(row: Pick<VisitRow, "visit_kind" | "source" | "double2_hr_id" | "double2_name">): DoubleReceivedKind {
  const kind = String(row.visit_kind ?? "").trim().toLowerCase();
  if (kind === "chain" || kind === "product_manager" || kind === "double") return kind;
  // A row naming a second companion is a chain whatever door it came through.
  if (String(row.double2_hr_id ?? row.double2_name ?? "").trim()) return "chain";
  return "double";
}
function describeVs(value: number | null, benchmark: number): string {
  if (value == null || benchmark <= 0) return "—";
  const ratio = value / benchmark;
  const diff = Math.round(Math.abs(ratio - 1) * 100);
  if (diff <= 5) return "on par with the company average";
  return `${diff}% ${ratio > 1 ? "above" : "below"} the company average`;
}

/**
 * `listsByContact` is the rep's current list (contact -> AM / PM / Pharmacy); it only decides which
 * lane a most-visited customer is shown in. Absent (a manager, a list that failed to load), every
 * customer is placed by its visits' own signals — see {@link customerLaneOf}.
 */
export function summarizeVisits(
  visits: VisitRow[],
  window: Employee360Window,
  listsByContact?: ReadonlyMap<number, ReadonlySet<CrmListType>>,
  /** The confirmed national holidays in the window; they leave the working days. `complete: false` is shown. */
  holidays?: { dates: CallRateHolidays; complete: boolean },
): VisitSummary {
  let regularVisits = 0;
  let campaignVisits = 0;
  let trainingVisits = 0;
  let adminVisits = 0;
  let doublesReceived = 0;
  const doublesReceivedByKind: DoublesReceivedByKind = { withManager: 0, chain: 0, withProductManager: 0 };
  const doublesReceivedDaySet = new Set<string>();
  let productiveDoubles = 0;
  // THE AM · PM · PHARMACIES GOLDEN RULE: every counted visit lands in exactly one of the three.
  const split = emptyVisitCountSplit();
  const activeDaySet = new Set<string>();
  const customerCount = new Map<string, { name: string; count: number; lanes: Record<CustomerLane, number> }>();
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
    if (isCrmDoubleVisitRow(row)) {
      doublesReceived += 1;
      if (row.visit_date) doublesReceivedDaySet.add(row.visit_date);
      const kind = doubleReceivedKind(row);
      if (kind === "chain") doublesReceivedByKind.chain += 1;
      else if (kind === "product_manager") doublesReceivedByKind.withProductManager += 1;
      else doublesReceivedByKind.withManager += 1;
    }

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
        const c = customerCount.get(key) ?? { name: customerNameOf(row), count: 0, lanes: { am: 0, pm: 0, pharmacy: 0 } };
        c.count += 1;
        const lane = customerLaneOf(row, listsByContact);
        if (lane) c.lanes[lane] += 1;
        customerCount.set(key, c);
      }
      // Through the golden rule's one helper: a pharmacy is a pharmacy whatever period the rep tagged,
      // an AM tag is AM, and anything else (PM, or no period at all) is PM. There is no fourth bucket.
      // The helper also counts the Phoenix CRM rows, so the page can say a Phoenix rep's pharmacy figure
      // was never recorded rather than print a zero (visit-count-buckets.ts).
      addVisitToSplit(split, row);
    }
  }

  const productiveVisits = regularVisits + campaignVisits;
  const regularShare = productiveVisits > 0 ? regularVisits / productiveVisits : null;
  const campaignShare = productiveVisits > 0 ? campaignVisits / productiveVisits : null;
  const activeDays = activeDaySet.size;
  const visitsPerActiveDay = activeDays > 0 ? productiveVisits / activeDays : null;

  const campaignMix = campaignMixVerdictOf(campaignVisits, productiveVisits);

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
  // Over the visits that reached a customer, not all productive visits: a campaign visit reaches
  // nobody (customerKeyOf), so dividing it in would credit every customer with work never done there.
  const customerVisits = customers.reduce((sum, c) => sum + c.count, 0);
  const avgVisitsPerCustomer = distinctCustomers > 0 ? customerVisits / distinctCustomers : null;
  // Each customer sits in ONE lane — the one most of their visits read, AM before PM before
  // pharmacy on a tie — so a doctor seen in both sessions is never listed twice.
  const topCustomers: TopCustomersByLane = {
    am: { customers: 0, top: [] },
    pm: { customers: 0, top: [] },
    pharmacy: { customers: 0, top: [] },
    unplaced: 0,
  };
  const byLane: Record<CustomerLane, NamedCount[]> = { am: [], pm: [], pharmacy: [] };
  for (const c of customers) {
    let lane: CustomerLane | null = null;
    for (const candidate of CUSTOMER_LANES) {
      if (c.lanes[candidate] > 0 && (lane == null || c.lanes[candidate] > c.lanes[lane])) lane = candidate;
    }
    if (!lane) {
      topCustomers.unplaced += 1;
      continue;
    }
    topCustomers[lane].customers += 1;
    if (c.name !== "—") byLane[lane].push({ name: c.name, count: c.count });
  }
  for (const lane of CUSTOMER_LANES) {
    topCustomers[lane].top = byLane[lane]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, TOP_CUSTOMERS_PER_LANE);
  }

  // The call rate's working days. The numerator counts only the active days that are working days, so a
  // Thursday or holiday visit never pushes utilization past what the denominator allows.
  const workingDaysInWindow = countWorkingDays(window.from, window.to, holidays?.dates);
  let workingActiveDays = 0;
  for (const day of activeDaySet) if (isCallRateWorkingDay(day, holidays?.dates)) workingActiveDays += 1;
  const utilization = workingDaysInWindow > 0 ? workingActiveDays / workingDaysInWindow : null;

  const b = EMPLOYEE_360_BENCHMARKS;
  const campaignTrend = campaignMixTrendOf(monthly);
  const summaryText =
    productiveVisits === 0
      ? "No productive visits recorded in this window."
      : `${productiveVisits.toLocaleString()} productive visits over ${activeDays} active days ` +
        `(${visitsPerActiveDay?.toFixed(1)}/day, ${describeVs(visitsPerActiveDay, b.visitsPerActiveDay)}). ` +
        `Mix is ${Math.round((regularShare ?? 0) * 100)}% regular / ${Math.round((campaignShare ?? 0) * 100)}% campaign — ${CAMPAIGN_MIX_WORDS[campaignMix]}.${describeCampaignTrend(campaignTrend)} ` +
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
    campaignMix,
    campaignTrend,
    activeDays,
    visitsPerActiveDay,
    distinctCustomers,
    doublesReceived,
    doublesReceivedByKind,
    doublesReceivedDays: doublesReceivedDaySet.size,
    singleVisits: productiveVisits - productiveDoubles,
    amVisits: split.am,
    pmVisits: split.pm,
    pharmacyVisits: split.pharmacies,
    phoenixVisits: split.phoenix ?? 0,
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
    ...(holidays ? { holidaysComplete: holidays.complete } : {}),
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
  const [visits, checkins, holidays] = await Promise.all([
    fetchVisitRows(hrId, window),
    fetchCheckinRows(hrId, window),
    loadCallRateHolidays(window.from, window.to),
  ]);
  const visitSummary = summarizeVisits(visits, window, undefined, holidays);
  const checkinSummary = summarizeCheckins(checkins, visits, visitSummary);
  return { hrId, window, benchmarks: EMPLOYEE_360_BENCHMARKS, isMapped: visits.length > 0, ...visitSummary, ...checkinSummary };
}
