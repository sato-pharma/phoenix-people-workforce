// ─────────────────────────────────────────────────────────────────────────────
// Call rate — the owner's own KPI, split so a fabricated call cannot inflate it.
//
// THE RULE (owner, 2026-08-27). A medical rep's perfect month is TWO AM accounts
// and TEN PM clinics on every working day. So the rep does not have one call
// rate, he has two:
//
//     AM call rate = AM calls / working days   → target  2
//     PM call rate = PM calls / working days   → target 10
//
// WORKING DAYS are Saturday, Sunday, Monday, Tuesday and Wednesday only. Friday
// is the weekend. THURSDAY WAS ONCE COUNTED TOO — the owner first said "count
// Thursday as 0.5 working day", then SUPERSEDED that on 2026-09-05 with "donot
// count thursday as working day" / "visists to be counted from sat to wednesday
// only regular visits": Thursday is now excluded outright, from both the
// denominator (see CALL_RATE_WEEKDAYS) and the numerator below. The denominator
// is the CALENDAR count of Sat–Wed days in the period — not the days the rep
// happened to work. The owner was explicit: twenty visits done across Sunday
// and Monday is 20/5, never 20/2.
//
// THE NUMERATOR IS NOW WEEKDAY-GATED TOO (2026-09-05 fix). Before this date the
// denominator above was already Sat–Wed, but `computeCallRate`'s per-visit loop
// counted every visit handed to it regardless of what day it fell on — so a
// Thursday visit still inflated a rep's AM/PM slice even though Thursday could
// never appear in workingDays. Every visit is now checked against
// {@link isCallRateWorkingDay} (the same rule the denominator uses, holidays
// included) before it is added to a session or pharmacy slice. This does NOT
// touch `campaignShare`, `perDay` or the daily-campaign-limit flagging below —
// that is a separate anti-fraud feature the 2026-09-05 ruling does not mention,
// and it still watches every day the rep logged anything, Thursday included.
//
// PHARMACIES ARE NOT AM/PM (owner, 2026-09-05): "am/pm coverage and call rate
// are separate from pharmacies coverage and call rate" / "a rep must have am/pm
// but not must have pharmacies". A visit to a pharmacy — identified by the
// visited contact's own `speciality` field, or by the vendor's undocumented -30
// code carrying a pharmacy-flavored comment (see {@link isPharmacyVisit}) — is
// pulled OUT of the am/pm slices entirely and into its own `pharmacy` slice,
// regardless of which AM/PM flag the row happens to carry. THE PHARMACY TARGET
// IS NOT SET ANYWHERE — {@link PHARMACY_CALL_RATE_TARGET} is null on purpose
// until the owner supplies one; every reader must treat null as "not configured
// yet", not as zero. A rep with zero pharmacy visits is NORMAL, never a gap:
// measured on production Sat–Wed August 2026, 43 of 76 reps who did any regular
// field work had none at all, while 0 of the same 76 had zero AM/PM — pharmacies
// are optional, AM/PM is universal.
//
// NATIONAL HOLIDAYS COME OUT of that count (owner, 2026-09-02): "if we have a
// national vacation in this week, then the week will be four." The rep's OWN
// approved leave does not — he ruled on both the same day, and the distinction
// is what keeps the denominator identical for every rep in a month. See
// countCallRateWorkingDays.
//
// WHY THE SPLIT EXISTS. A visit reaches the CRM by one of two routes:
//
//   • a REGULAR visit, against a registered customer — carries a contact id, a
//     grade, a region, a speciality, and (96.5% of the time) a GPS check-in;
//   • a CAMPAIGN call, against a doctor who is not a registered customer — so
//     it carries NO contact, NO location and NO check-in. That is by design,
//     not a defect: there is nothing in the system to attach it to. See the
//     header of crm/checkin-match.ts, which states the same thing from the
//     matcher's side.
//
// The consequence is that the CRM places no restriction on the campaign route,
// and a campaign row is a date, a rep, an AM/PM flag and a sentence. Nothing in
// it can be checked by anybody. Measured on production over June–August 2026:
// 10,918 campaign calls, 20.4% of all field work; 16 reps who had a real
// approved doctor list routed more than a third of their calls through it
// anyway; 507 rep-days consisted of five or more campaign calls and not one
// verified visit; and 612 rep-days that fell short of the daily standard were
// lifted to it by campaign calls alone.
//
// Coverage and frequency are structurally immune to this, because both key on a
// contact id that a campaign call does not have. CALL RATE IS NOT — it counts
// rows, so it absorbs the fabrication completely. That is the entire reason this
// module reports three numbers and never one total:
//
//     verified    regular visit WITH a matching GPS check-in
//     unverified  regular visit, real contact, but no check-in that day
//     campaign    no contact at all — unverifiable by construction
//
// `verifiedRate` is the headline. A caller that sums the three back into a
// single figure has undone the point of the module.
//
// This file is PURE — it takes rows and returns numbers, so the rules above can
// be tested without a database. The reader that fetches the rows lives in
// crm/call-rate-service.ts and goes through the crm/reads.ts single-source door.
// ─────────────────────────────────────────────────────────────────────────────

import { indexCheckinsByAgentContactDay, pickCheckinForVisit, type CheckinForMatch } from "@/lib/crm/checkin-match";
import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { classifyVisit } from "@/lib/crm/visit-types";

/** Two AM accounts every working day (owner's standard). */
export const AM_CALL_RATE_TARGET = 2;
/** Ten PM clinics/polyclinics every working day (owner's standard). */
export const PM_CALL_RATE_TARGET = 10;
/**
 * No owner-set target exists for pharmacy calls anywhere in this codebase, and this file must not
 * invent one. Null, deliberately, until the owner supplies a number (parked as an open question,
 * 2026-09-05: "what is the pharmacy call-rate target per working day?"). Every consumer has to
 * treat null as "not configured yet" — never default it to 0, which would read as "zero calls
 * expected" rather than "no standard set".
 */
export const PHARMACY_CALL_RATE_TARGET: number | null = null;

/**
 * More than this many campaign calls in one day is flagged for the district
 * manager. Owner's number, 2026-08-27: "two or three a day is prospecting;
 * fourteen is not". Three is the LIMIT, so four is the first flagged day.
 */
export const DAILY_CAMPAIGN_LIMIT = 3;

/**
 * The daily visit-average band — owner's own words, 2026-09-05: "the kpis tells call rate in
 * month should be 10 to achieve this should make visits / day av 8-12 and coverage no less than
 * 95%." 10 is the target and the midpoint of the tolerance band; 8 and 12 are its edges. (It is
 * not a coincidence that 2 + 10 = 12, the AM and PM targets above.)
 *
 * THIS IS DELIBERATELY THE ONE PLACE AM AND PM ARE SUMMED. It answers a different question than
 * the split call rate does — "how much verified field work happened today", not "did he hit his
 * AM or his PM number" — so it is not the blended figure the owner banned on 2026-09-04 ("this two
 * and this ten. Don't never get average"). It must never replace the AM/PM split reported
 * elsewhere on the board.
 *
 * VERIFIED ONLY, on purpose: a campaign call names no doctor and is unverifiable by construction
 * (see the module header above), and letting it buy a rep into this band would be exactly the
 * fabrication call rate exists to resist. See {@link verifiedVisitsPerDay}.
 *
 * ABOVE 12 IS NOT A PASS. The owner's own campaign-limit ruling two lines up — an implausibly high
 * count is a flag, not a strength — applies here too: a caller must render the "above" band
 * distinctly from "in-band" and never colour it as a win. See {@link dailyVisitBandOf}.
 *
 * PHARMACY IS EXCLUDED — owner's decision, 2026-09-06, asked directly rather than assumed:
 * once `codex/call-rate-ampm-pharmacy-split` splits pharmacy visits out of AM/PM, this band stays
 * AM/PM ONLY. Pharmacy work is scored on its own coverage/call-rate over there, not folded back in
 * here. So a caller implementing that split must keep {@link verifiedVisitsPerDay} fed from the
 * AM/PM slices alone — never `am + pm + pharmacy`. Today, before that split exists, AM/PM already
 * IS everything, so this is a forward-compatibility note rather than a present behaviour change:
 * company visits/day will read LOWER once pharmacy is carved out (measured August 2026: 8.05/day
 * pharmacy-inclusive vs 7.30/day AM/PM-only), which is intended, not a regression.
 */
export const DAILY_VISIT_RATE_TARGET = 10;
/** The band's lower edge. Under this is `"below"` — short of the standard. */
export const DAILY_VISIT_RATE_MIN = 8;
/** The band's upper edge. Over this is `"above"` — a volume flag, not automatically a win. */
export const DAILY_VISIT_RATE_MAX = 12;

/** Where a verified-visits-per-day figure sits against the owner's 8-12 band. */
export type DailyVisitBand = "below" | "in-band" | "above";

/**
 * Verified AM + PM visits per working day — the input {@link dailyVisitBandOf} buckets.
 *
 * `null` with no working days, matching every other rate in this module — there is nothing here to
 * divide by, which is different from a rep who worked and logged zero.
 */
export function verifiedVisitsPerDay(amVerified: number, pmVerified: number, workingDays: number): number | null {
  if (workingDays <= 0) return null;
  return (amVerified + pmVerified) / workingDays;
}

/**
 * Buckets a verified-visits-per-day figure against {@link DAILY_VISIT_RATE_MIN}–
 * {@link DAILY_VISIT_RATE_MAX}. `null` in is `null` out — no working days to measure means there is
 * nothing to have fallen short of, which must never be folded silently into `"below"`.
 */
export function dailyVisitBandOf(visitsPerDay: number | null): DailyVisitBand | null {
  if (visitsPerDay == null) return null;
  if (visitsPerDay < DAILY_VISIT_RATE_MIN) return "below";
  if (visitsPerDay > DAILY_VISIT_RATE_MAX) return "above";
  return "in-band";
}

/**
 * The weekdays that make up the call-rate denominator, as JavaScript day-of-week
 * indexes (0 = Sunday … 6 = Saturday): Saturday, Sunday, Monday, Tuesday,
 * Wednesday. Thursday (4) and Friday (5) are both absent — Friday is the
 * weekend, and Thursday is NOT a working day either (owner, 2026-09-05,
 * superseding an earlier "count Thursday as 0.5" instruction): "donot count
 * thursday as working day". Since 2026-09-05 this set governs the NUMERATOR as
 * well as the denominator — see {@link isCallRateWorkingDay} and the header.
 */
export const CALL_RATE_WEEKDAYS: ReadonlySet<number> = new Set([6, 0, 1, 2, 3]);

/**
 * Day-of-week for a date-only `YYYY-MM-DD` string.
 *
 * Parsed as UTC midnight deliberately. `visit_date` is a Cairo CALENDAR day with
 * no time and no zone, so it must never be pushed through a timezone conversion
 * — `new Date("2026-08-01")` is already UTC-parsed by spec, but the explicit
 * suffix makes that a stated intent rather than a spec detail a reader has to
 * recall. crm/dates.ts's cairoDayOfWeek is the wrong tool here: it takes a real
 * instant and converts it into Cairo, which is correct for "what day is it right
 * now" and wrong for "what weekday is this stored date".
 */
export function weekdayOfIsoDate(dateIso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return null;
  const parsed = new Date(`${dateIso}T00:00:00Z`);
  const day = parsed.getUTCDay();
  return Number.isFinite(day) ? day : null;
}

/**
 * A set of `YYYY-MM-DD` days that do NOT count toward the denominator even though
 * they are Sat–Wed. See {@link countCallRateWorkingDays}.
 */
export type CallRateHolidays = ReadonlySet<string>;

/**
 * True when this calendar day counts toward the call-rate denominator — and, since 2026-09-05,
 * toward the numerator too. A visit logged on a day this returns false for must not be added to
 * any AM/PM or pharmacy slice in {@link computeCallRate}, exactly as it is already excluded from
 * {@link countCallRateWorkingDays}.
 *
 * `holidays` is optional so every existing caller keeps the pure weekday rule.
 */
export function isCallRateWorkingDay(dateIso: string, holidays?: CallRateHolidays): boolean {
  const weekday = weekdayOfIsoDate(dateIso);
  if (weekday === null || !CALL_RATE_WEEKDAYS.has(weekday)) return false;
  return !holidays?.has(dateIso);
}

/**
 * How many Sat–Wed days fall in `[dateFrom, dateTo]`, both inclusive, MINUS any
 * of them that are national holidays.
 *
 * THE HOLIDAY RULE (owner, 2026-09-02), stated to me as: "if we have a national
 * vacation in this week, then the week will be four." A rep's ordinary week is
 * five countable days (Sat–Wed); a public holiday inside it removes one, so the
 * week he is measured against is four. Without this, a national holiday silently
 * inflates the denominator and every rep's call rate reads LOW for that month —
 * an accusation manufactured by the calendar rather than by the rep.
 *
 * WHAT IS *NOT* SUBTRACTED, also the owner's ruling on the same day: the rep's
 * own approved leave. The denominator stays a CALENDAR count of the days the
 * company was open, not a count of the days this rep was available — which keeps
 * the 2026-08-27 rule intact ("twenty visits done across Sunday and Monday is
 * 20/5, never 20/2"). Two reps in the same month therefore always share a
 * denominator, and a rep cannot improve his rate by taking leave.
 *
 * `holidays` is OPTIONAL and omitting it reproduces the pre-2026-09-02 behaviour
 * exactly, so this is additive for every existing caller. The set must hold plain
 * `YYYY-MM-DD` strings; loading it is crm/call-rate-holidays.ts's job, and that
 * reader carries the warning about an unreachable holiday calendar.
 *
 * Returns 0 for a reversed or malformed range rather than throwing — a caller
 * dividing by this must check it, and every rate below is null when it is 0.
 */
export function countCallRateWorkingDays(
  dateFrom: string,
  dateTo: string,
  holidays?: CallRateHolidays,
): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) return 0;
  if (dateFrom > dateTo) return 0;
  let count = 0;
  const cursor = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    // toISOString is safe here and only here: the cursor is built from a UTC
    // midnight and only ever advanced by whole UTC days, so it can never drift
    // into the previous day the way a Cairo wall-clock date would.
    if (CALL_RATE_WEEKDAYS.has(cursor.getUTCDay()) && !holidays?.has(cursor.toISOString().slice(0, 10))) {
      count += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * Expands holiday RANGES into the individual days they cover.
 *
 * A national vacation is commonly several days (Eid runs three or four), and the
 * calendar returns it as ONE entry with a start and an end. Subtracting such an
 * entry as a single day would leave two or three holidays still sitting in the
 * denominator — the same silent inflation this whole rule exists to remove.
 *
 * `endDate` is nullable on the source type and a null means a one-day holiday.
 * An end BEFORE the start is treated as one day rather than trusted, because the
 * alternative is an unbounded loop on bad vendor data.
 *
 * Pure, and deliberately in this module rather than beside the reader, so the
 * expansion can be tested without a database or a live Google calendar.
 */
export function expandHolidayDates(
  ranges: readonly { startDate: string; endDate?: string | null }[],
): Set<string> {
  const dates = new Set<string>();
  for (const range of ranges) {
    const start = range.startDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) continue;
    const rawEnd = range.endDate ?? start;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(rawEnd) && rawEnd >= start ? rawEnd : start;
    const cursor = new Date(`${start}T00:00:00Z`);
    const last = new Date(`${end}T00:00:00Z`);
    while (cursor.getTime() <= last.getTime()) {
      dates.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return dates;
}

/** Which of the three proof buckets a single call belongs to. */
export type CallProof = "verified" | "unverified" | "campaign";

/** AM, PM, or a row the CRM left without an AM/PM flag. */
export type CallSession = "am" | "pm" | "unspecified";

/**
 * The AM/PM flag, normalised.
 *
 * The production mirror stores a clean uppercase `AM`/`PM`, but the vendor's own
 * live API returns mixed case on the same rows (`Pm`, `pm`, `Am` all observed in
 * one rep-day), so the sync is the only thing standing between that and this
 * calculation. Normalising here as well costs nothing and means a caller reading
 * the live client directly gets the same answer as one reading the mirror.
 */
export function normalizeSession(ampm: string | null | undefined): CallSession {
  const value = (ampm ?? "").trim().toLowerCase();
  if (value === "am") return "am";
  if (value === "pm") return "pm";
  return "unspecified";
}

/**
 * One session's (or pharmacy's) counts and rates. Never sum the three proof buckets back up.
 *
 * Generic over `target` so AM/PM and pharmacy can share one shape while disagreeing on whether a
 * target even exists: AM/PM always carry a real number, pharmacy carries null until the owner sets
 * one (see {@link PHARMACY_CALL_RATE_TARGET}). `finalizeSlice` reads `target` polymorphically, so a
 * null target simply means `attainmentPct` stays null — never zero, never a division.
 */
type CallRateSliceOf<Target extends number | null> = {
  /** Regular visit with a matching same-day GPS check-in at the same contact. */
  verified: number;
  /** Regular visit against a real contact, but no check-in that day. */
  unverified: number;
  /** Campaign call — no contact, so no check-in is possible. */
  campaign: number;
  /** verified + unverified + campaign. Reported for transparency, not as the KPI. */
  total: number;
  /** THE headline: verified / workingDays. Null when the period has no working days. */
  verifiedRate: number | null;
  /** total / workingDays — what the rep's number looks like if nobody checks. */
  totalRate: number | null;
  /** 2 for AM, 10 for PM, null for pharmacy (no owner-set standard yet). */
  target: Target;
  /** verifiedRate as a percentage of target. Null when the rate OR the target is null. */
  attainmentPct: number | null;
};

/** AM/PM slice — always has a real target. */
export type CallRateSlice = CallRateSliceOf<number>;

/** Pharmacy slice — same shape, but the target is not configured yet. See the header. */
export type PharmacyCallRateSlice = CallRateSliceOf<number | null>;

/** A day a rep exceeded the campaign limit. */
export type CampaignOverLimitDay = {
  day: string;
  campaignCalls: number;
  /** Verified visits the same day — zero here is the strongest version of the signal. */
  verifiedCalls: number;
};

export type RepCallRate = {
  agentCrmId: number | null;
  agentHrId: string | null;
  agentName: string;
  /** Sat–Wed calendar days in the period — the denominator for every rate below. */
  workingDays: number;
  am: CallRateSlice;
  pm: CallRateSlice;
  /**
   * Pharmacy calls — never AM/PM, regardless of which flag the row carries (owner, 2026-09-05: "a
   * pharmacy is not a contact" / "am/pm coverage and call rate are separate from pharmacies
   * coverage and call rate"). See {@link isPharmacyVisit}.
   */
  pharmacy: PharmacyCallRateSlice;
  /** Rows the CRM left with no AM/PM flag AND are not a pharmacy call; counted here and in no slice. */
  unspecified: number;
  /** Share of this rep's calls that took the campaign route, 0–1. */
  campaignShare: number;
  /** Days over the campaign limit, worst first. */
  campaignOverLimitDays: CampaignOverLimitDay[];
  /** Days with campaign calls and not one verified visit. */
  campaignOnlyDays: number;
};

export type CallRateReport = {
  dateFrom: string;
  dateTo: string;
  workingDays: number;
  /** Sat–Wed days removed from the denominator because they are national holidays. Reported so a
   * board can say "23 working days, 2 holidays" rather than presenting an unexplained 21. */
  holidayDays: number;
  campaignLimit: number;
  reps: RepCallRate[];
};

/** Minimum visit shape. Matches the mirror's column names so callers pass rows straight through. */
export type VisitForCallRate = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  ampm: string | null;
  contact_crm_id: number | null;
  crm_save_date: string | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
  /**
   * The visited contact's medical specialty/kind from iReports360 (null on campaign and other
   * non-customer visit types). The ONLY signal, together with a pharmacy-flavored -30 comment, that
   * routes a call into the pharmacy slice instead of AM/PM — see {@link isPharmacyVisit}.
   */
  speciality: string | null;
};

function emptySlice<Target extends number | null>(target: Target): CallRateSliceOf<Target> {
  return { verified: 0, unverified: 0, campaign: 0, total: 0, verifiedRate: null, totalRate: null, target, attainmentPct: null };
}

function finalizeSlice<Target extends number | null>(
  slice: CallRateSliceOf<Target>,
  workingDays: number,
): CallRateSliceOf<Target> {
  slice.total = slice.verified + slice.unverified + slice.campaign;
  if (workingDays <= 0) return slice;
  slice.verifiedRate = slice.verified / workingDays;
  slice.totalRate = slice.total / workingDays;
  slice.attainmentPct = slice.target != null && slice.target > 0 ? (slice.verifiedRate / slice.target) * 100 : null;
  return slice;
}

/**
 * Whether a visit counts toward the pharmacy call rate rather than AM/PM.
 *
 * Two signals, because pharmacy identity reaches the visits table two different ways: the common
 * case is a registered contact's own `speciality` (see {@link isPharmacySpeciality}); the vendor's
 * undocumented -30 code carries no contact at all, so the only signal left is the rep's own
 * free-text comment, which {@link classifyVisit} already routes to the "Pharmacy Visit" label. Note
 * a CAMPAIGN call (-8) is NEVER a pharmacy call by this function — campaign rows carry no contact
 * and classifyVisit never applies the comment-sniffing route to them, so a campaign call always
 * lands in AM/PM/unspecified exactly as it did before this split existed.
 */
export function isPharmacyVisit(visit: VisitForCallRate): boolean {
  if (isPharmacySpeciality(visit.speciality)) return true;
  return classifyVisit(visit.visit_type, visit.comment, visit.visit_type_description).label === "Pharmacy Visit";
}

/**
 * A rep who logged NOTHING in the window — the row this report cannot produce on its own.
 *
 * `computeCallRate` buckets VISIT ROWS, so a rep with no rows is absent from `reps` entirely. That
 * is right for a report and wrong for a ROSTER: a board that lists a manager's team has to be able
 * to add back the people the feed is silent about, and the rep who did nothing is precisely the one
 * such a board exists to surface. Built here rather than spelled out at the call site because a new
 * field on {@link RepCallRate} must not be able to leave a second "all zeroes" literal quietly
 * behind — that literal would keep compiling and start lying.
 *
 * The slices are FINALIZED against the window's working days, so a rep with two working days and no
 * calls reads `0.00` and `0%` rather than `—`. The em dash means "there is nothing to divide by";
 * zero over two days is a measurement, and stating it as an absence would understate it.
 */
export function zeroRepCallRate(
  workingDays: number,
  identity: { agentCrmId?: number | null; agentHrId: string | null; agentName?: string },
): RepCallRate {
  return {
    agentCrmId: identity.agentCrmId ?? null,
    agentHrId: identity.agentHrId,
    agentName: identity.agentName ?? "",
    workingDays,
    am: finalizeSlice(emptySlice(AM_CALL_RATE_TARGET), workingDays),
    pm: finalizeSlice(emptySlice(PM_CALL_RATE_TARGET), workingDays),
    pharmacy: finalizeSlice(emptySlice(PHARMACY_CALL_RATE_TARGET), workingDays),
    unspecified: 0,
    campaignShare: 0,
    campaignOverLimitDays: [],
    campaignOnlyDays: 0,
  };
}

/**
 * Which proof bucket a visit falls into.
 *
 * Routes on the shared {@link classifyVisit} bucket rather than comparing
 * `visit_type` to -8 directly, so the campaign definition cannot drift from the
 * rest of the CRM domain. Note that bucket "regular" covers BOTH the documented
 * type 0 and the undocumented -30 (a real field visit the vendor never labelled)
 * — a -30 row with no check-in lands in `unverified`, which is the honest answer
 * rather than a silent exclusion.
 *
 * Anything that is neither regular nor campaign — leave, meetings, training,
 * admin work — is not field work and returns null so the caller skips it.
 */
export function classifyCallProof<C extends CheckinForMatch>(
  visit: VisitForCallRate,
  checkinIndex: Map<string, C[]>,
): CallProof | null {
  const { bucket } = classifyVisit(visit.visit_type, visit.comment, visit.visit_type_description);
  if (bucket === "campaign") return "campaign";
  if (bucket !== "regular") return null;
  const matched = pickCheckinForVisit(
    {
      agentCrmId: visit.agent_crm_id,
      contactCrmId: visit.contact_crm_id,
      visitDay: (visit.visit_date ?? "").slice(0, 10) || null,
      crmSaveDate: visit.crm_save_date,
    },
    checkinIndex,
  );
  return matched ? "verified" : "unverified";
}

/**
 * The split call rate, per rep, for a period.
 *
 * `visits` should already have been through the caller's usual duplicate-
 * submission collapse — this function counts what it is given and deliberately
 * does not dedupe, so it cannot silently disagree with the visit totals shown
 * elsewhere on the same screen.
 */
export function computeCallRate<C extends CheckinForMatch>(
  visits: readonly VisitForCallRate[],
  checkins: readonly C[],
  options: { dateFrom: string; dateTo: string; campaignLimit?: number; holidays?: CallRateHolidays },
): CallRateReport {
  const { dateFrom, dateTo } = options;
  const campaignLimit = options.campaignLimit ?? DAILY_CAMPAIGN_LIMIT;
  const workingDays = countCallRateWorkingDays(dateFrom, dateTo, options.holidays);
  // Deliberately the DIFFERENCE between the two counts, not `options.holidays.size`. The caller's
  // set covers whole months, so it holds Thursdays, Fridays and days outside the period — none of
  // which were ever in the denominator. Only the ones actually removed are reportable.
  const holidayDays = countCallRateWorkingDays(dateFrom, dateTo) - workingDays;
  const checkinIndex = indexCheckinsByAgentContactDay(checkins);

  type Accumulator = {
    agentCrmId: number | null;
    agentHrId: string | null;
    agentName: string;
    am: CallRateSlice;
    pm: CallRateSlice;
    pharmacy: PharmacyCallRateSlice;
    unspecified: number;
    fieldCalls: number;
    campaignCalls: number;
    perDay: Map<string, { campaign: number; verified: number }>;
  };
  const byRep = new Map<string, Accumulator>();

  for (const visit of visits) {
    const proof = classifyCallProof(visit, checkinIndex);
    if (!proof) continue;

    const key = visit.agent_crm_id != null ? `crm:${visit.agent_crm_id}` : `name:${visit.agent_name ?? ""}`;
    let rep = byRep.get(key);
    if (!rep) {
      rep = {
        agentCrmId: visit.agent_crm_id,
        agentHrId: visit.agent_hr_id,
        agentName: visit.agent_name ?? "",
        am: emptySlice(AM_CALL_RATE_TARGET),
        pm: emptySlice(PM_CALL_RATE_TARGET),
        pharmacy: emptySlice(PHARMACY_CALL_RATE_TARGET),
        unspecified: 0,
        fieldCalls: 0,
        campaignCalls: 0,
        perDay: new Map(),
      };
      byRep.set(key, rep);
    }
    // An hr_id resolved on a later row is still the same rep — keep the first real one we see
    // rather than letting a null on one row blank an identity another row already supplied.
    if (rep.agentHrId == null && visit.agent_hr_id != null) rep.agentHrId = visit.agent_hr_id;

    rep.fieldCalls += 1;
    if (proof === "campaign") rep.campaignCalls += 1;

    // The daily-campaign-limit bookkeeping below is a SEPARATE anti-fraud feature the 2026-09-05
    // Sat–Wed ruling does not touch — it still watches every day the rep logged anything, Thursday
    // included, exactly as it always has.
    const day = (visit.visit_date ?? "").slice(0, 10);
    if (day) {
      const bucket = rep.perDay.get(day) ?? { campaign: 0, verified: 0 };
      if (proof === "campaign") bucket.campaign += 1;
      if (proof === "verified") bucket.verified += 1;
      rep.perDay.set(day, bucket);
    }

    // THE 2026-09-05 GATE: a visit that fell on a day outside the call-rate denominator (Thursday,
    // Friday, or a national holiday) must not inflate any AM/PM or pharmacy slice either — see the
    // file header. Everything above this line (fieldCalls, campaignCalls, perDay) is deliberately
    // unaffected, because campaignShare and the daily-limit flag are a different feature.
    if (!isCallRateWorkingDay(day, options.holidays)) continue;

    // Pharmacy is ORTHOGONAL to AM/PM, not a third value of it: a pharmacy call is pulled out
    // regardless of which AM/PM flag it carries (owner, 2026-09-05 — see the header).
    if (isPharmacyVisit(visit)) {
      rep.pharmacy[proof] += 1;
      continue;
    }

    const session = normalizeSession(visit.ampm);
    if (session === "unspecified") rep.unspecified += 1;
    else rep[session][proof] += 1;
  }

  const reps: RepCallRate[] = [];
  for (const rep of byRep.values()) {
    const overLimit: CampaignOverLimitDay[] = [];
    let campaignOnlyDays = 0;
    for (const [day, counts] of rep.perDay) {
      if (counts.campaign > campaignLimit) {
        overLimit.push({ day, campaignCalls: counts.campaign, verifiedCalls: counts.verified });
      }
      if (counts.campaign > 0 && counts.verified === 0) campaignOnlyDays += 1;
    }
    overLimit.sort((a, b) => b.campaignCalls - a.campaignCalls || a.day.localeCompare(b.day));

    reps.push({
      agentCrmId: rep.agentCrmId,
      agentHrId: rep.agentHrId,
      agentName: rep.agentName,
      workingDays,
      am: finalizeSlice(rep.am, workingDays),
      pm: finalizeSlice(rep.pm, workingDays),
      pharmacy: finalizeSlice(rep.pharmacy, workingDays),
      unspecified: rep.unspecified,
      campaignShare: rep.fieldCalls > 0 ? rep.campaignCalls / rep.fieldCalls : 0,
      campaignOverLimitDays: overLimit,
      campaignOnlyDays,
    });
  }

  reps.sort((a, b) => b.campaignShare - a.campaignShare || a.agentName.localeCompare(b.agentName));
  return { dateFrom, dateTo, workingDays, holidayDays, campaignLimit, reps };
}
