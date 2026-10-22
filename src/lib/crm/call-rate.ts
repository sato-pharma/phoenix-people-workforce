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
// A PHOENIX CRM VISIT IS ITS OWN CHECK-IN (owner's ruling, 2026-10-02: a team
// that works in Phoenix CRM is counted from it on every other screen, from the
// team's start — see crm/phoenix-team-starts.ts). Phoenix captures every visit
// live, with the phone's location read silently, and deliberately shows that
// location back as NO check-in row (the rep is never told it is read — golden
// rule #1). So a Phoenix row is `verified` without looking for one, and it is a
// reading of the rep's GPS feed of its own: without both, every Phoenix rep read
// 0 or "No GPS feed" while he worked. A vendor row is judged exactly as before.
// One Phoenix rule rides along: a visit to a customer not validated yet reaches
// no slice ("not counted in KPIs till validated", owner, 2026-10-01) — it is the
// `not-validated` reason of {@link callRateExclusionOf}, the one gate every
// call-rate screen already reads.
//
// This file is PURE — it takes rows and returns numbers, so the rules above can
// be tested without a database. The reader that fetches the rows lives in
// crm/call-rate-service.ts and goes through the crm/reads.ts single-source door.
// ─────────────────────────────────────────────────────────────────────────────

import {
  checkinAgentKey,
  indexCheckinsByAgentContactDay,
  pickCheckinForVisit,
  type CheckinForMatch,
} from "@/lib/crm/checkin-match";
import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { classifyVisit } from "@/lib/crm/visit-types";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "@/lib/hr-id";
import { isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";

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

// A COMBINED AM+PM "visits/day" band (target 10, band 8-12) shipped here briefly on 2026-09-05,
// reading the owner's "call rate in month should be 10 ... visits/day av 8-12" as one summed
// figure. Retracted the same week: asked directly, the owner's answer was "10 PM · 2 AM" — the
// 8-12 band belongs to PM ALONE, not to AM+PM combined. AM keeps its own flat target with no band.
// That correct, per-list model lives in crm/rep-kpi-reports.ts's `DEFAULT_REP_KPI_STANDARDS` (see
// `PM.callRateBand`). Do not re-add a combined figure here — it is exactly the blend the owner
// banned on 2026-09-04 ("this two and this ten. Don't never get average"), just under a new name.

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
 * The CRM's catch-all contact. NOT a doctor, a pharmacy or an account — reps log against it when
 * they have nobody real to log against (99 reps, 511 addresses, 415 km apart, measured 2026-08-28),
 * so it poisons every per-contact figure it reaches. Declared HERE, the lowest module that needs it;
 * crm/rep-kpi-reports.ts re-exports it, because that file imports this one and not the reverse.
 */
export const CATCH_ALL_CONTACT_CRM_ID = 100000;

/**
 * Why a field call does not reach the call rate, or null when it does.
 *
 * ONE GATE, READ BY EVERY SCREEN THAT SHOWS A CALL RATE. {@link computeCallRate} asks it before it
 * adds a visit to any AM, PM or pharmacy slice, and the rep drill-down (crm/rep-visits.ts) asks it
 * of every row it lists, so the reader sees "not scored · Thursday" beside the very rows the rate
 * left out. Before 2026-09-21 the drill-down re-derived the weekday half without the holidays and
 * skipped the catch-all half altogether, and it listed 112 Thursday and Friday visits in one
 * September with proof chips and nothing to say they were not in the number above them.
 *
 *   weekend        Thursday or Friday — not Sat–Wed (owner, 2026-09-05)
 *   holiday        a Sat–Wed national holiday, out of the denominator (owner, 2026-09-02)
 *   catch-all      contact {@link CATCH_ALL_CONTACT_CRM_ID}, which is nobody
 *   not-validated  a Phoenix CRM visit whose customer is not validated yet: saved, and "not counted in
 *                  KPIs till validated" (owner, 2026-10-01) — Phoenix CRM's own reports wait for the
 *                  same thing, and the moment the customer is validated the visit counts in its own day.
 *                  Pass the visit row to have it asked; a caller that passes none asks the first three.
 *
 * The catch-all is tested FIRST: a Thursday call to nobody is a call to nobody.
 */
export type CallRateExclusion = "weekend" | "holiday" | "catch-all" | "not-validated";

export function callRateExclusionOf(
  dateIso: string,
  contactCrmId: number | null | undefined,
  holidays?: CallRateHolidays,
  visit?: Pick<VisitForCallRate, "crm_visit_id" | "source" | "phoenix_customer_validated">,
): CallRateExclusion | null {
  if (contactCrmId === CATCH_ALL_CONTACT_CRM_ID) return "catch-all";
  if (!isCallRateWorkingDay(dateIso)) return "weekend";
  if (holidays?.has(dateIso)) return "holiday";
  if (visit && isPhoenixNativeVisitRow(visit) && visit.phoenix_customer_validated === false) return "not-validated";
  return null;
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
  /**
   * Which rule scored THIS row — his own team's, not the board's. The switch went per go-live team on
   * 2026-10-07 (owner: "switched gradually based on the go live teams"), so one board legitimately
   * holds both: a started rep's every submitted regular visit counts ("submitted"), while a rep still
   * on iReports360 needs a matching GPS check-in ("verified"). Absent on a row nothing computed —
   * readers fall back to the board's basis, which is what they did before per-team starts existed.
   */
  basis?: CallRateBasis;
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
  /**
   * Phoenix CRM visits this rep SAVED that score nothing yet, because the customer he called on is
   * not validated (`not-validated` in {@link callRateExclusionOf}; "not counted in KPIs till
   * validated", owner 2026-10-01).
   *
   * It exists because the gate is invisible and the first month of a started team is the worst case
   * for it: measured on production on 2026-10-02, the day before Delta (1) began, **0 of its 1,551
   * customers were validated**. Every visit those reps make scores nothing until their lists are
   * worked through, so a manager reading the board sees a flat 0 and no reason for it — the same
   * shape of unreadable zero that `hasNoGpsFeed` was written to explain. {@link awaitingValidationNote}
   * is the sentence that replaces it.
   *
   * It is a COUNT OF WHAT WAS DONE, never a score: nothing here enters a slice, a rate or a target,
   * and validating the customer moves the visit into its own day exactly as before.
   */
  awaitingValidation: number;
  /** Share of this rep's calls that took the campaign route, 0–1. */
  campaignShare: number;
  /** Days over the campaign limit, worst first. */
  campaignOverLimitDays: CampaignOverLimitDay[];
  /** Days with campaign calls and not one verified visit. */
  campaignOnlyDays: number;
  /**
   * GPS check-ins this rep's CRM account sent inside the window — on ANY contact and any day, so it
   * measures the FEED, not the matches. Zero beside real regular visits means the CRM received no
   * GPS from him at all, which {@link hasNoGpsFeed} reads as "No GPS feed" rather than as a rep who
   * proved nothing (owner, 2026-09-21, ruling A1). Keyed exactly as the match is
   * ({@link checkinAgentKey}), so a check-in that could prove one of his visits is always counted
   * here. Optional so a hand-built fixture keeps compiling; ABSENT means "not measured" and is never
   * read as zero.
   */
  gpsCheckins?: number;
};

/**
 * A rep who logged real field visits in the window while his account sent NO GPS check-ins at all.
 *
 * OWNER'S RULING A1, 2026-09-21: "use A1 no GPS feed for reps without check-ins". Before the CRM
 * cutover the headline counts only GPS-proved visits, so a rep whose phone never reported a check-in
 * read a red 0% however much he worked — the board was measuring the feed, not the rep. Such a rep
 * is now shown as "No GPS feed" and left out of the team figures, while his reported calls stay on
 * the row.
 *
 * Deliberately narrow — each condition is a case the ruling does NOT cover:
 *  • basis "verified" only. From the cutover every submitted visit counts and GPS is evidence only,
 *    so a missing feed costs him nothing and there is nothing to excuse.
 *  • ZERO check-ins, not zero MATCHED ones. A rep whose feed is live but whose visits find no
 *    same-contact check-in keeps his real 0% — that gap is the exact thing this board exists to show.
 *  • at least one REGULAR visit on a scored day. A rep with no visits at all (the silent roster row)
 *    or with campaign calls only did no work a GPS feed could have proved, and his zero stays a zero.
 *  • `gpsCheckins` measured. Absent means the caller never counted the feed, never that it was empty.
 */
/**
 * The one sentence a manager reads instead of an unexplained zero, or null when nothing is waiting.
 *
 * Deliberately a plain statement of fact about the LIST, not about the rep: his visits are saved and
 * they will count the moment the customer is validated. Nothing here is a warning, a flag or a
 * figure anyone is scored on, and the rep never sees it — the boards it appears on are the manager's
 * (Phoenix CRM golden rule #1).
 */
export function awaitingValidationNote(rep: Pick<RepCallRate, "awaitingValidation">): string | null {
  const count = rep.awaitingValidation;
  if (count <= 0) return null;
  return count === 1
    ? "1 visit saved, waiting for its customer to be validated"
    : `${count} visits saved, waiting for their customers to be validated`;
}

export function hasNoGpsFeed(rep: RepCallRate, basis?: CallRateBasis): boolean {
  // WHICH BASIS DECIDES. `basis` is an explicit override for a caller holding rows it did not compute;
  // otherwise the ROW's own basis answers, because since the switch went per team (owner, 2026-10-07)
  // ONE board holds both rules at once and a single board-wide value is wrong for half of it. A rep on
  // the Phoenix rules has nothing to excuse — a missing feed costs him no credit, so "No GPS feed"
  // would excuse a penalty he never paid. A row with no stamped basis is read as "verified", the rule
  // before the cutover, so a hand-built row behaves exactly as it did.
  if ((basis ?? rep.basis ?? "verified") !== "verified") return false;
  if (rep.gpsCheckins !== 0) return false;
  const regularVisits =
    rep.am.verified + rep.am.unverified + rep.pm.verified + rep.pm.unverified + rep.pharmacy.verified + rep.pharmacy.unverified;
  return regularVisits > 0;
}

export type CallRateReport = {
  dateFrom: string;
  dateTo: string;
  workingDays: number;
  /** Sat–Wed days removed from the denominator because they are national holidays. Reported so a
   * board can say "23 working days, 2 holidays" rather than presenting an unexplained 21. */
  holidayDays: number;
  campaignLimit: number;
  reps: RepCallRate[];
  /** Which visits the headline rate counts. Absent means "verified", the rule before the CRM cutover. */
  basis?: CallRateBasis;
  /** Why a period split by the cutover kept the old rule. See phoenix-kpi-rules.ts. */
  basisNote?: string | null;
};

/**
 * What the headline rate (`verifiedRate`, `attainmentPct`) counts.
 *
 * "verified" is the rule before the CRM cutover: a regular visit with a same-day GPS check-in.
 * "submitted" is the Phoenix KPI rule from the cutover (phase 6, owner-approved): every submitted
 * regular visit counts and GPS is evidence only. Campaign calls stay outside the rate either way.
 * The field keeps its name so every screen reads one headline; the three proof buckets are unchanged.
 */
export type CallRateBasis = "verified" | "submitted";

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
  /**
   * What marks a Phoenix CRM row ({@link isPhoenixNativeVisitRow}): `source` 'phoenix', or the
   * NEGATIVE id the unified view gives it. Optional — a caller that selects neither reads every row
   * as a vendor row, the rule before Phoenix rows existed.
   */
  crm_visit_id?: number | null;
  source?: string | null;
  /**
   * On a Phoenix CRM row, whether its customer is validated yet (null on a vendor row). A `false`
   * keeps the visit out of every slice — {@link callRateExclusionOf}'s `not-validated`.
   */
  phoenix_customer_validated?: boolean | null;
};

function emptySlice<Target extends number | null>(target: Target): CallRateSliceOf<Target> {
  return { verified: 0, unverified: 0, campaign: 0, total: 0, verifiedRate: null, totalRate: null, target, attainmentPct: null };
}

function finalizeSlice<Target extends number | null>(
  slice: CallRateSliceOf<Target>,
  workingDays: number,
  basis: CallRateBasis = "verified",
): CallRateSliceOf<Target> {
  slice.total = slice.verified + slice.unverified + slice.campaign;
  if (workingDays <= 0) return slice;
  const headline = basis === "submitted" ? slice.verified + slice.unverified : slice.verified;
  slice.verifiedRate = headline / workingDays;
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
 *
 * AND THE CUSTOMER'S OWN LIST, first — the third signal, and the one a Phoenix CRM pharmacy call
 * carries: the unified view hands its `list_type` over as `ampm`, so `ampm = 'Pharmacy'` is a pharmacy
 * whatever its speciality says. The same rule `isPharmacyVisitRow` (crm/visit-count-buckets.ts) has
 * applied since 2026-10-04; this board kept reading the speciality alone, and a pharmacy a rep added in
 * Phoenix has none — measured on production 2026-10-22, 257 October Phoenix pharmacy calls had a NULL
 * speciality and landed in "unspecified", in no lane at all (35 of them Mariam Younan's). No
 * iReports360 row carries `ampm = 'Pharmacy'`, so no vendor figure moves.
 */
export function isPharmacyVisit(visit: VisitForCallRate): boolean {
  if (isPharmacyListType(visit.ampm)) return true;
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
    awaitingValidation: 0,
    campaignShare: 0,
    campaignOverLimitDays: [],
    campaignOnlyDays: 0,
    gpsCheckins: 0,
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
  // A Phoenix CRM visit was captured on the spot with the phone's location — its own check-in, and
  // Phoenix shows that location back as no check-in row at all. See the file header.
  if (isPhoenixNativeVisitRow(visit)) return "verified";
  const matched = pickCheckinForVisit(
    {
      agentCrmId: visit.agent_crm_id,
      agentHrId: visit.agent_hr_id,
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
  options: {
    dateFrom: string;
    dateTo: string;
    campaignLimit?: number;
    holidays?: CallRateHolidays;
    /** Omit for "verified". Only a caller that read the CRM cutover passes "submitted". */
    basis?: CallRateBasis;
    /**
     * Reps scored by the PHOENIX rules whatever `basis` says — their team went live before this period
     * began. Keys in `normalizeHrIdForAccess` form, the form `loadStartedRepWindows` returns.
     *
     * This is what makes one board hold both rules at once (owner, 2026-10-07): the switch is per
     * go-live team, and before it a started rep's submitted visits were judged against the vendor's
     * GPS rule — a rule his own app does not follow.
     */
    phoenixBasisHrKeys?: ReadonlySet<string>;
  },
): CallRateReport {
  const { dateFrom, dateTo } = options;
  const basis: CallRateBasis = options.basis ?? "verified";
  const phoenixKeys = options.phoenixBasisHrKeys;
  /** His own team's rule, falling back to the board's. */
  const basisForRep = (agentHrId: string | null): CallRateBasis => {
    if (!phoenixKeys || phoenixKeys.size === 0) return basis;
    const key = normalizeHrIdForAccess(agentHrId);
    return key && phoenixKeys.has(key) ? "submitted" : basis;
  };
  const campaignLimit = options.campaignLimit ?? DAILY_CAMPAIGN_LIMIT;
  const workingDays = countCallRateWorkingDays(dateFrom, dateTo, options.holidays);
  // Deliberately the DIFFERENCE between the two counts, not `options.holidays.size`. The caller's
  // set covers whole months, so it holds Thursdays, Fridays and days outside the period — none of
  // which were ever in the denominator. Only the ones actually removed are reportable.
  const holidayDays = countCallRateWorkingDays(dateFrom, dateTo) - workingDays;
  const checkinIndex = indexCheckinsByAgentContactDay(checkins);
  // The FEED per rep, for ruling A1 — every check-in that names an agent and a time, including the
  // contact-less ones the match index skips: a check-in with no contact still proves the phone was
  // reporting GPS. Same agent key as the match, so the two can never disagree about whose it is.
  const checkinsByAgent = new Map<string, number>();
  for (const checkin of checkins) {
    const agentKey = checkinAgentKey(checkin.agent_crm_id, checkin.agent_hr_id);
    if (agentKey == null || !checkin.check_date) continue;
    checkinsByAgent.set(agentKey, (checkinsByAgent.get(agentKey) ?? 0) + 1);
  }
  // A Phoenix CRM visit is a reading of the same phone's location (see the file header), so a rep who
  // works in Phoenix CRM has a live feed and is never set aside as "No GPS feed".
  for (const visit of visits) {
    if (!isPhoenixNativeVisitRow(visit) || !visit.visit_date) continue;
    const agentKey = checkinAgentKey(visit.agent_crm_id, visit.agent_hr_id);
    if (agentKey == null) continue;
    checkinsByAgent.set(agentKey, (checkinsByAgent.get(agentKey) ?? 0) + 1);
  }

  type Accumulator = {
    agentCrmId: number | null;
    agentHrId: string | null;
    agentName: string;
    am: CallRateSlice;
    pm: CallRateSlice;
    pharmacy: PharmacyCallRateSlice;
    unspecified: number;
    awaitingValidation: number;
    fieldCalls: number;
    campaignCalls: number;
    perDay: Map<string, { campaign: number; verified: number }>;
  };
  const byRep = new Map<string, Accumulator>();

  for (const visit of visits) {
    const proof = classifyCallProof(visit, checkinIndex);
    if (!proof) continue;

    // CRM id first, so a rep who has one keeps his key. A native rep hired after the cutover has
    // none, and grouping him by NAME would split him from — or merge him with — anyone who shares
    // the spelling; his hr id is the identity he actually has. The name stays the last resort only.
    const hrKey = canonicalHrIdKey(visit.agent_hr_id);
    const key =
      visit.agent_crm_id != null ? `crm:${visit.agent_crm_id}` : hrKey ? `hr:${hrKey}` : `name:${visit.agent_name ?? ""}`;
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
        awaitingValidation: 0,
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
    // file header. Nor, since 2026-09-21, a visit to the catch-all contact, which is nobody.
    // Everything above this line (fieldCalls, campaignCalls, perDay) is deliberately unaffected,
    // because campaignShare and the daily-limit flag are a different feature. The drill-down reads
    // the SAME gate — callRateExclusionOf — so its "not scored" rows are exactly these.
    // The reason is kept rather than discarded: a visit held back only because its customer is not
    // validated yet is work the rep DID, and a manager has to be able to read why his board says 0.
    const exclusion = callRateExclusionOf(day, visit.contact_crm_id, options.holidays, visit);
    if (exclusion) {
      if (exclusion === "not-validated") rep.awaitingValidation += 1;
      continue;
    }

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
    // A rep with neither a CRM id nor an hr id has no agent key, so no check-in can ever be his:
    // zero, which is what the match would find too.
    const agentKey = checkinAgentKey(rep.agentCrmId, rep.agentHrId);

    // HIS team's rule, not the board's: a board spanning a go-live Saturday holds both.
    const repBasis = basisForRep(rep.agentHrId);

    reps.push({
      agentCrmId: rep.agentCrmId,
      agentHrId: rep.agentHrId,
      agentName: rep.agentName,
      basis: repBasis,
      workingDays,
      am: finalizeSlice(rep.am, workingDays, repBasis),
      pm: finalizeSlice(rep.pm, workingDays, repBasis),
      pharmacy: finalizeSlice(rep.pharmacy, workingDays, repBasis),
      unspecified: rep.unspecified,
      awaitingValidation: rep.awaitingValidation,
      campaignShare: rep.fieldCalls > 0 ? rep.campaignCalls / rep.fieldCalls : 0,
      campaignOverLimitDays: overLimit,
      campaignOnlyDays,
      gpsCheckins: agentKey ? (checkinsByAgent.get(agentKey) ?? 0) : 0,
    });
  }

  reps.sort((a, b) => b.campaignShare - a.campaignShare || a.agentName.localeCompare(b.agentName));
  return { dateFrom, dateTo, workingDays, holidayDays, campaignLimit, reps, basis };
}
