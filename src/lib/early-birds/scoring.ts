// The Early Birds scoring rule. PURE: no database, no clock, no async, no randomness. Every input
// arrives as an argument so the whole policy can be tested against fixed rows.
//
// This file is the module's `calculations.ts` — the eligibility predicate lives HERE rather than in
// the snapshot writer, so what the dashboard shows and what the snapshot commits cannot drift. That
// split is copied from the deductions module, where the two disagreeing is how HR once read a total
// roughly three times larger than what publish would actually commit.

import { fieldWorkforceDeductionDayWeight } from "@/lib/field-workforce-compliance/weekend-policy";
import type {
  EarlyBirdsComponentScores,
  EarlyBirdsDayFact,
  EarlyBirdsIneligibleReason,
  EarlyBirdsRanking,
  EarlyBirdsRepContext,
  EarlyBirdsRepScore,
  EarlyBirdsVisitFact,
} from "@/lib/early-birds/types";
import type { EarlyBirdsPeriod } from "@/lib/early-birds/period";
import { earlyBirdsPeriodDays } from "@/lib/early-birds/period";

/**
 * Bump when any constant below changes. Persisted on every snapshot so an old fortnight can always
 * be read back with the rule that actually produced it, instead of being silently reinterpreted.
 */
export const EARLY_BIRDS_SCORING_VERSION = 1;

/** Weights sum to exactly 1.00. Changing one is a business decision, not a tuning knob. */
export const EARLY_BIRDS_WEIGHTS = {
  start: 0.3,
  consistency: 0.25,
  regular: 0.2,
  volume: 0.15,
  firstPlace: 0.1,
} as const;

/** 08:00 scores 1.0, 12:00 scores 0.0. */
export const EARLY_BIRDS_START_BEST_MINUTES = 8 * 60;
export const EARLY_BIRDS_START_WORST_MINUTES = 12 * 60;

/**
 * A clock earlier than this is not a start time — it is paperwork.
 *
 * Measured on 2026-07-H2: 628 of 8,473 fieldwork visits (7.4%) carry a `crm_save_date` before
 * 05:00, i.e. a rep writing up the previous day after midnight. Because a day's start is the
 * MINIMUM over its visits, one such save drags the whole day to 00:30 — and on real production data
 * that handed a district to a rep with a "median start" of 02:25 over a colleague who genuinely
 * started at 09:18 with eight daily wins.
 *
 * The visit still counts in full for volume, Regular and consistency: the rep did the work. What is
 * discarded is only its CLAIM to be a start time. 05:00 is deliberately conservative — just 66
 * visits in the whole fortnight fall between 05:00 and 07:00, so nothing real is lost.
 */
export const EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES = 5 * 60;

/** True when a clock can credibly be the moment a field day began. */
export function isPlausibleEarlyBirdsStart(minutes: number | null): minutes is number {
  return minutes !== null && Number.isFinite(minutes) && minutes >= EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES;
}

/** The worst possible GPS record costs 15% of the total — never a disqualification. */
export const EARLY_BIRDS_GPS_QUALITY_FLOOR = 0.85;

/**
 * Calibrated, not guessed. Measured over 2026-07-H2 (816 rep-days, 88 med reps, Fridays excluded):
 * visits/day p50 11, p75 13, p90 16; Regular/day p50 9, p75 11. Set at p75 so roughly a quarter of
 * reps saturate and the component still discriminates across the rest.
 *
 * Set these too LOW and every rep hits 1.0, which silently deletes two of the five components and
 * degenerates the score into start-time + consistency. Re-run the calibration if the field force
 * changes size materially.
 */
export const EARLY_BIRDS_VISITS_PER_DAY_TARGET = 13;
export const EARLY_BIRDS_REGULAR_PER_DAY_TARGET = 11;

/** A Cairo half-month is ~11 med-rep working days; five is under half. */
export const EARLY_BIRDS_MIN_ACTIVE_DAYS = 5;
/** Stops a rep hired on the 13th scoring consistency 1.0 off three days. */
export const EARLY_BIRDS_MIN_EXPECTED_WORKING_DAYS = 8;
/** A day only counts as won if somebody could actually have lost it. */
export const EARLY_BIRDS_MIN_SUBMITTERS_FOR_DAILY_WIN = 2;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Six decimals: enough to separate real differences, coarse enough that float dust cannot order people. */
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export function earlyBirdsStartScore(medianStartMinutes: number | null): number {
  if (medianStartMinutes === null || !Number.isFinite(medianStartMinutes)) return 0;
  const span = EARLY_BIRDS_START_WORST_MINUTES - EARLY_BIRDS_START_BEST_MINUTES;
  return clamp01((EARLY_BIRDS_START_WORST_MINUTES - medianStartMinutes) / span);
}

export function earlyBirdsConsistencyScore(daysWithSubmission: number, expectedWeight: number): number {
  if (!(expectedWeight > 0)) return 0;
  return clamp01(daysWithSubmission / expectedWeight);
}

export function earlyBirdsVolumeScore(totalVisits: number, expectedDays: number): number {
  if (!(expectedDays > 0)) return 0;
  return clamp01(totalVisits / (EARLY_BIRDS_VISITS_PER_DAY_TARGET * expectedDays));
}

export function earlyBirdsRegularScore(regularVisits: number, expectedDays: number): number {
  if (!(expectedDays > 0)) return 0;
  return clamp01(regularVisits / (EARLY_BIRDS_REGULAR_PER_DAY_TARGET * expectedDays));
}

/** Zero — never NaN — on a fortnight where no day was contested. */
export function earlyBirdsFirstPlaceScore(dailyWins: number, contestedDays: number): number {
  if (!(contestedDays > 0)) return 0;
  return clamp01(dailyWins / contestedDays);
}

/**
 * GPS is a QUALITY WEIGHT, not a filter.
 *
 * `gpsShare` is measured over GPS-ELIGIBLE visits only, so a Campaign-heavy rep is never marked
 * down for lacking evidence his visit type cannot carry. `null` (no eligible visit at all) resolves
 * to 1.0, not 0 — and gaming that by doing only Campaign work already costs more than it saves,
 * because `regularScore` then goes to zero, which is worth 0.20 against the 0.15 this could take.
 */
export function earlyBirdsQualityWeight(gpsShare: number | null): number {
  const share = gpsShare === null || !Number.isFinite(gpsShare) ? 1 : clamp01(gpsShare);
  return EARLY_BIRDS_GPS_QUALITY_FLOOR + (1 - EARLY_BIRDS_GPS_QUALITY_FLOOR) * share;
}

export function earlyBirdsBaseScore(components: EarlyBirdsComponentScores): number {
  return (
    EARLY_BIRDS_WEIGHTS.start * components.start +
    EARLY_BIRDS_WEIGHTS.consistency * components.consistency +
    EARLY_BIRDS_WEIGHTS.regular * components.regular +
    EARLY_BIRDS_WEIGHTS.volume * components.volume +
    EARLY_BIRDS_WEIGHTS.firstPlace * components.firstPlace
  );
}

type EligibilityFacts = {
  daysWithSubmission: number;
  expectedWorkingDays: number;
  medianStartMinutes: number | null;
  activeAtPeriodEnd: boolean;
};

/**
 * The single eligibility predicate, shared by the live preview and the snapshot writer.
 *
 * Two-sided on purpose. The activity guard stops a rep winning off one lucky 07:10 morning; the
 * coverage guard stops a rep hired on the 13th winning on three perfect days, which the activity
 * guard alone does not catch.
 */
export function isEarlyBirdsEligible(facts: EligibilityFacts): {
  eligible: boolean;
  reasons: EarlyBirdsIneligibleReason[];
} {
  const reasons: EarlyBirdsIneligibleReason[] = [];
  if (facts.daysWithSubmission === 0) reasons.push("no_submissions");
  else if (facts.daysWithSubmission < EARLY_BIRDS_MIN_ACTIVE_DAYS) reasons.push("insufficient_active_days");
  if (facts.expectedWorkingDays < EARLY_BIRDS_MIN_EXPECTED_WORKING_DAYS) reasons.push("insufficient_period_coverage");
  if (facts.medianStartMinutes === null) reasons.push("no_start_time_evidence");
  if (!facts.activeAtPeriodEnd) reasons.push("not_active_at_period_end");
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Total order. Every tier is deterministic and the last is the HR id, so the sort can never depend
 * on input order — falling back to roster order would rank people by their sales figures and let
 * the same pair swap places between two renders.
 */
export function compareEarlyBirdsScores(a: EarlyBirdsRepScore, b: EarlyBirdsRepScore): number {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
  const aStart = a.medianStartMinutes ?? Number.MAX_SAFE_INTEGER;
  const bStart = b.medianStartMinutes ?? Number.MAX_SAFE_INTEGER;
  if (aStart !== bStart) return aStart - bStart;
  if (a.daysWithSubmission !== b.daysWithSubmission) return b.daysWithSubmission - a.daysWithSubmission;
  if (a.gpsVerifiedVisits !== b.gpsVerifiedVisits) return b.gpsVerifiedVisits - a.gpsVerifiedVisits;
  if (a.regularVisits !== b.regularVisits) return b.regularVisits - a.regularVisits;
  if (a.dailyWins !== b.dailyWins) return b.dailyWins - a.dailyWins;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.hrIdKey.localeCompare(b.hrIdKey);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Rounded to a whole minute: an even-length median averages two clocks, and a raw 666.5 renders
  // as "11:6.5", which reads as a defect rather than as a time.
  const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value);
}

/**
 * THE scorer.
 *
 * `dailyWinnerHrIdKeys` maps a Cairo day to the rep who was #1 on the DM's daily board that day, or
 * null when the day was uncontested. It is supplied rather than derived here so the fortnightly
 * "#1 days" number is literally what the manager saw on the daily board — see daily-board.ts.
 */
export function buildEarlyBirdsRanking(input: {
  period: EarlyBirdsPeriod;
  reps: readonly EarlyBirdsRepContext[];
  facts: readonly EarlyBirdsVisitFact[];
  dailyWinnerHrIdKeys: ReadonlyMap<string, string | null>;
  /**
   * `${hrIdKey}|${dateIso}` -> minutes of that rep's first GPS check-in. THE ranking clock.
   *
   * Owner decision 2026-08-09, after the times were reported wrong for every rep. The old rule took
   * the earliest resolved visit time, which falls back to `crm_save_date` when no check-in matched
   * — and that column is submission time, which this repo's own CRM master table labels "paperwork
   * time, NOT proof of being on site... often hours later or the next morning". Measured on
   * production: save time ran a median 57 minutes and a mean 307 minutes behind the GPS check-in,
   * and a quarter of rep-days were ranked on it, against three quarters ranked on GPS. Two clocks,
   * one leaderboard.
   *
   * Omit it and NO rep has a verified start — the board shows an unranked field rather than
   * silently falling back to paperwork time.
   */
  gpsStartByRepDay?: ReadonlyMap<string, number>;
  /** Clamp for a live preview so future days never count as missed. */
  throughIso?: string;
}): EarlyBirdsRanking {
  const periodDays = earlyBirdsPeriodDays(input.period, input.throughIso);

  let contestedDays = 0;
  for (const day of periodDays) {
    if (input.dailyWinnerHrIdKeys.get(day)) contestedDays += 1;
  }

  const factsByRep = new Map<string, EarlyBirdsVisitFact[]>();
  for (const fact of input.facts) {
    const bucket = factsByRep.get(fact.hrIdKey);
    if (bucket) bucket.push(fact);
    else factsByRep.set(fact.hrIdKey, [fact]);
  }

  const scores: EarlyBirdsRepScore[] = input.reps.map((rep) => {
    const repFacts = factsByRep.get(rep.hrIdKey) ?? [];

    const byDay = new Map<string, EarlyBirdsVisitFact[]>();
    for (const fact of repFacts) {
      const bucket = byDay.get(fact.dateIso);
      if (bucket) bucket.push(fact);
      else byDay.set(fact.dateIso, [fact]);
    }

    const timeline: EarlyBirdsDayFact[] = [];
    const firstStarts: number[] = [];
    let dailyWins = 0;

    for (const dateIso of periodDays) {
      const dayFacts = byDay.get(dateIso) ?? [];
      // GPS ONLY. A day with visits but no check-in is real work with no verified start — it keeps
      // counting for submissions, volume, Regular and Campaign, and contributes no start time.
      // Paperwork time is never promoted into the ranking, however tempting the gap looks.
      const gpsStart = input.gpsStartByRepDay?.get(`${rep.hrIdKey}|${dateIso}`);
      const startMinutes =
        gpsStart !== undefined && isPlausibleEarlyBirdsStart(gpsStart) ? gpsStart : null;
      const timeSource: EarlyBirdsDayFact["timeSource"] = startMinutes === null ? "none" : "gps_checkin";
      if (startMinutes !== null) firstStarts.push(startMinutes);
      const wonDay = input.dailyWinnerHrIdKeys.get(dateIso) === rep.hrIdKey;
      if (wonDay) dailyWins += 1;
      timeline.push({
        dateIso,
        startMinutes,
        timeSource,
        visits: dayFacts.length,
        wonDay,
        expectedWeight: fieldWorkforceDeductionDayWeight({ dateIso }),
      });
    }

    const daysWithSubmission = Array.from(byDay.keys()).filter((day) => periodDays.includes(day)).length;
    const totalVisits = repFacts.length;
    const regularVisits = repFacts.filter((fact) => fact.visitType === 0).length;
    const campaignVisits = repFacts.filter((fact) => fact.visitType === -8).length;
    const gpsEligibleVisits = repFacts.filter((fact) => fact.gpsEligible).length;
    const gpsVerifiedVisits = repFacts.filter((fact) => fact.timeSource === "gps_checkin").length;
    const gpsShare = gpsEligibleVisits > 0 ? gpsVerifiedVisits / gpsEligibleVisits : null;
    const gpsVerifiedDays = firstStarts.length;
    const medianStartMinutes = median(firstStarts);

    const components: EarlyBirdsComponentScores = {
      start: earlyBirdsStartScore(medianStartMinutes),
      consistency: earlyBirdsConsistencyScore(daysWithSubmission, rep.expectedWorkingDayWeight),
      regular: earlyBirdsRegularScore(regularVisits, rep.expectedWorkingDays),
      volume: earlyBirdsVolumeScore(totalVisits, rep.expectedWorkingDays),
      firstPlace: earlyBirdsFirstPlaceScore(dailyWins, contestedDays),
    };

    const baseScore = earlyBirdsBaseScore(components);
    const qualityWeight = earlyBirdsQualityWeight(gpsShare);
    const { eligible, reasons } = isEarlyBirdsEligible({
      daysWithSubmission,
      expectedWorkingDays: rep.expectedWorkingDays,
      medianStartMinutes,
      activeAtPeriodEnd: rep.activeAtPeriodEnd,
    });

    return {
      hrIdKey: rep.hrIdKey,
      hrId: rep.hrId,
      name: rep.name,
      totalScore: round6(baseScore * qualityWeight),
      baseScore: round6(baseScore),
      qualityWeight: round6(qualityWeight),
      components,
      medianStartMinutes,
      daysWithSubmission,
      expectedWorkingDays: rep.expectedWorkingDays,
      expectedWorkingDayWeight: rep.expectedWorkingDayWeight,
      totalVisits,
      regularVisits,
      campaignVisits,
      gpsEligibleVisits,
      gpsVerifiedVisits,
      gpsVerifiedDays,
      gpsShare: gpsShare === null ? null : round6(gpsShare),
      dailyWins,
      eligible,
      ineligibleReasons: reasons,
      timeline,
    };
  });

  scores.sort(compareEarlyBirdsScores);

  return {
    period: input.period,
    scores,
    candidates: scores.filter((score) => score.eligible),
    contestedDays,
  };
}
