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
// WORKING DAYS are Saturday, Sunday, Monday, Tuesday and Wednesday. Thursday is
// a normal AM working day but is deliberately NOT counted here, and Friday is
// off. The denominator is the CALENDAR count of those weekdays in the period —
// not the days the rep happened to work. The owner was explicit: twenty visits
// done across Sunday and Monday is 20/5, never 20/2.
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
import { classifyVisit } from "@/lib/crm/visit-types";

/** Two AM accounts every working day (owner's standard). */
export const AM_CALL_RATE_TARGET = 2;
/** Ten PM clinics/polyclinics every working day (owner's standard). */
export const PM_CALL_RATE_TARGET = 10;

/**
 * More than this many campaign calls in one day is flagged for the district
 * manager. Owner's number, 2026-08-27: "two or three a day is prospecting;
 * fourteen is not". Three is the LIMIT, so four is the first flagged day.
 */
export const DAILY_CAMPAIGN_LIMIT = 3;

/**
 * THE PM CALL-RATE BAND — the owner's tolerance around the PM target of ten.
 *
 * SETTLED 2026-09-06. Asked directly, and shown the measurement below, the owner answered that the
 * 8-12 band is PM ALONE: "8-12 pm only and 2 am accounts", restated unprompted the same day as
 * "pm band 8-12 and monthly cr target 10". AM keeps its own flat target of 2 and NO band, so a rep
 * is never bought into this band by his mornings.
 *
 * WHAT THIS REPLACES — recorded rather than deleted, because the next session should not have to
 * rediscover it. Two readings of "8-12" were live on `main` at once, merged 22 minutes apart on
 * 2026-09-05 (PR #3331 flagged the disagreement without guessing at it):
 *
 *   THIS FILE (#3319) banded an AM + PM SUMMED visits-per-day figure, taken from his earlier and
 *     more general "call rate in month should be 10 to achieve this should make visits / day av
 *     8-12" — said before AM and PM had been separated in the conversation at all.
 *   rep-kpi-reports.ts (#3320) banded PM alone. That one was right, and is unchanged.
 *
 * They agreed on most reps and disagreed on 31 of 76 (August 2026, production, Sat-Wed, 23 working
 * days): 7 PM + 2 AM is 9 a day — IN-BAND when summed, and BELOW band on PM alone, which is the
 * answer. The same rep therefore read Met on one tab and Below on another, with nothing on screen
 * explaining why. Pinned by tests/pm-call-rate-band.test.ts.
 *
 * THE SUM IS GONE, not merely left unbanded. The docstring this replaces called itself
 * "deliberately the one place AM and PM are summed", on the grounds that it answered a different
 * question — "how much verified field work happened today" rather than "did he hit his number".
 * Every consumer was enumerated before this change and NO such reader existed: the summed figure
 * reached the board only to be bucketed here, and was then printed beside this band's chip,
 * coloured by this band's tone and filtered by this band's flags. Nothing measured it on its own,
 * so repointing the figure loses no question anybody was asking.
 *
 * THE SPLIT IS THEREFORE SAFER, NOT LOOSER. The owner's locked rule stands: AM and PM are never
 * averaged and never combined — not on a row, not in team totals, not as a band, not as a URL
 * param (2026-09-04, "this two and this ten. Don't never get average"). Deleting the one combined
 * figure on the board moves toward that rule. Do not reintroduce an `am + pm` input here:
 * {@link pmVerifiedPerDay} takes ONE visit count on purpose, so the old shape cannot be rebuilt by
 * accident rather than on purpose.
 *
 * ABOVE 12 IS NOT A PASS. The campaign-limit ruling above applies here too — an implausibly high
 * count is a flag, not a strength. A caller must render "above" distinctly from "in-band" and must
 * never colour it as a win. See {@link pmCallRateBandOf}.
 *
 * PHARMACY IS EXCLUDED — owner's decision, 2026-09-06, asked directly rather than assumed. Once
 * `codex/call-rate-ampm-pharmacy-split` carves pharmacy visits out of the PM slice, this band
 * stays PM only; pharmacy work is scored on its own coverage and call rate over there, never
 * folded back in here.
 *
 * VERIFIED ONLY, on purpose: a campaign call names no doctor and is unverifiable by construction
 * (see the module header), and letting it buy a rep into this band would be exactly the
 * fabrication call rate exists to resist.
 */
/** The band's lower edge. Under this is `"below"` — short of the standard, even at 7.99. */
export const PM_CALL_RATE_BAND_MIN = 8;
/** The band's upper edge. Over this is `"above"` — a volume flag, not automatically a win. */
export const PM_CALL_RATE_BAND_MAX = 12;

/** Where a PM verified-calls-per-day figure sits against the owner's 8-12 band. */
export type PmCallRateBand = "below" | "in-band" | "above";

/**
 * Verified PM visits per working day — the figure {@link pmCallRateBandOf} buckets.
 *
 * ONE visit count, deliberately. Its predecessor took `(amVerified, pmVerified, workingDays)` and
 * summed the first two, which is the defect this signature exists to make unrepeatable: there is
 * no argument here an AM count could be passed as.
 *
 * `null` with no working days, matching every other rate in this module — there is nothing to
 * divide by, which is a different statement from a rep who worked and logged zero.
 */
export function pmVerifiedPerDay(pmVerified: number, workingDays: number): number | null {
  if (workingDays <= 0) return null;
  return pmVerified / workingDays;
}

/**
 * Buckets a PM verified-calls-per-day figure against {@link PM_CALL_RATE_BAND_MIN}-
 * {@link PM_CALL_RATE_BAND_MAX}. Both edges are INSIDE the band: at 8.0 the rep meets the standard
 * even though {@link PM_CALL_RATE_TARGET} is 10, which is the whole reason the owner stated a band
 * rather than a bare target.
 *
 * `null` in is `null` out — no working days to measure means there is nothing to have fallen short
 * of, and that must never be folded silently into `"below"`.
 */
export function pmCallRateBandOf(pmPerDay: number | null): PmCallRateBand | null {
  if (pmPerDay == null) return null;
  if (pmPerDay < PM_CALL_RATE_BAND_MIN) return "below";
  if (pmPerDay > PM_CALL_RATE_BAND_MAX) return "above";
  return "in-band";
}

/**
 * The weekdays that make up the call-rate denominator, as JavaScript day-of-week
 * indexes (0 = Sunday … 6 = Saturday): Saturday, Sunday, Monday, Tuesday,
 * Wednesday. Thursday (4) and Friday (5) are deliberately absent — Thursday is
 * worked but not counted, Friday is the weekend.
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
 * True when this calendar day counts toward the call-rate denominator.
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

/** One session's counts and rates. Never sum the three proof buckets back up. */
export type CallRateSlice = {
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
  /** 2 for AM, 10 for PM. */
  target: number;
  /** verifiedRate as a percentage of target. Null when the rate is null. */
  attainmentPct: number | null;
};

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
  /** Rows the CRM left with no AM/PM flag; counted here and in neither slice. */
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
};

function emptySlice(target: number): CallRateSlice {
  return { verified: 0, unverified: 0, campaign: 0, total: 0, verifiedRate: null, totalRate: null, target, attainmentPct: null };
}

function finalizeSlice(slice: CallRateSlice, workingDays: number): CallRateSlice {
  slice.total = slice.verified + slice.unverified + slice.campaign;
  if (workingDays <= 0) return slice;
  slice.verifiedRate = slice.verified / workingDays;
  slice.totalRate = slice.total / workingDays;
  slice.attainmentPct = slice.target > 0 ? (slice.verifiedRate / slice.target) * 100 : null;
  return slice;
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

    const session = normalizeSession(visit.ampm);
    if (session === "unspecified") rep.unspecified += 1;
    else rep[session][proof] += 1;

    const day = (visit.visit_date ?? "").slice(0, 10);
    if (day) {
      const bucket = rep.perDay.get(day) ?? { campaign: 0, verified: 0 };
      if (proof === "campaign") bucket.campaign += 1;
      if (proof === "verified") bucket.verified += 1;
      rep.perDay.set(day, bucket);
    }
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
      unspecified: rep.unspecified,
      campaignShare: rep.fieldCalls > 0 ? rep.campaignCalls / rep.fieldCalls : 0,
      campaignOverLimitDays: overLimit,
      campaignOnlyDays,
    });
  }

  reps.sort((a, b) => b.campaignShare - a.campaignShare || a.agentName.localeCompare(b.agentName));
  return { dateFrom, dateTo, workingDays, holidayDays, campaignLimit, reps };
}
