// Transparent, explainable USAGE scoring for the Activity Control Center.
//
// This is a measure of how much of Phoenix a person used — not of how much work
// they did, and not a verdict on whether they were working. Most of their job
// happens off this system: in a pharmacy, on a call, in a meeting, in a car. A
// low score here means little Phoenix usage and nothing else.
//
// Three observable signals, each exposed so the UI can show how the number was
// reached:
//   • usage      — credited active minutes against a working-day expectation
//   • breadth    — how many distinct modules the person opened
//   • regularity — on how many of their working days they showed up at all
//
// What changed on 2026-09-26, and why:
//   1. The denominator was LOGGED-IN TIME, which is cookie lifetime: one person
//      accumulated 8,874 minutes in a 168-hour week by leaving a tab open. It
//      self-normalised — heavy users leave the browser open longest — so the
//      ratio compressed instead of separating anyone. It is now a working-day
//      expectation, a fixed yardstick that does not move with the person.
//   2. DEPTH (page views) is gone. It saturated at 25 views for nearly everyone
//      and it re-counted the same time the active term already counted.
//      REGULARITY replaces it: a genuinely independent axis, and the one that
//      separates a steady user from a single long burst.
//   3. The "no session baseline → treat any active time as fully engaged"
//      fallback is deleted. It manufactured the one and only High score in the
//      measured population, out of a person with no session rows at all.

/** A single page dwell longer than this is treated as "left the tab open", not
 * active work — capped so one forgotten tab can't inflate active time. */
export const ACTIVE_VIEW_CAP_SECONDS = 30 * 60;

/**
 * Full usage credit at this many credited active minutes per expected working
 * day. An hour and a half of FOREGROUND Phoenix on a working day is a heavy
 * office user; a field rep who opens the app to file a plan and a visit report
 * is nowhere near it, and should not be.
 *
 * MEASURED on production, 2026-09-26, over the last 30 days: 52 named people,
 * credited active minutes per expected working day — median 8.2, p75 18.0,
 * p90 45.9, p95 63.7, maximum 251.1.
 *
 * 90 rather than the 75th percentile the plan first named. At 18 the top
 * QUARTER of the company saturates the usage term and scores the same as each
 * other — which is the flattening this rescale exists to remove, arriving by a
 * different door. At 90 exactly one person saturates, and the top of the range
 * separates properly: 100 · 90 · 79 · 69 · 67 · 62 · 61 · 60 · 59 · 59 · 47.
 * Bands land 8 High / 18 Moderate / 26 Low, no band over half the population.
 * (120 was tried first and gives 3 High — too few to be a band at all.)
 *
 * It is the ONE knob. Move this, never the band thresholds, if the spread needs
 * adjusting, and re-measure rather than guessing — the query is in the PR that
 * introduced it.
 */
export const TARGET_MINUTES_PER_WORKING_DAY = 90;

const WEIGHTS = {
  usage: 0.7,
  breadth: 0.15,
  regularity: 0.15,
} as const;

/** Distinct modules at/above this count earns full breadth credit. */
const BREADTH_TARGET = 6;

export const ENGAGEMENT_BAND_THRESHOLDS = { high: 60, moderate: 30 } as const;

export type EngagementBand = "Low" | "Moderate" | "High";

export type EngagementInput = {
  /** Credited active seconds — overlapping page views already deduplicated. */
  activeSeconds: number;
  /** Scheduled working days in the window for this person's job title (≥ 1). */
  expectedWorkingDays: number;
  /** Count of distinct modules visited. */
  distinctModules: number;
  /** Distinct Cairo dates on which the person recorded at least one page view. */
  daysActive: number;
};

export type EngagementResult = {
  score: number;
  band: EngagementBand;
  usageScore: number;
  breadthScore: number;
  regularityScore: number;
  /** Credited active minutes per expected working day — the number behind `usageScore`. */
  activeMinutesPerWorkingDay: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** Cap a single page dwell so a forgotten open tab cannot dominate active time. */
export function cappedDwellSeconds(durationMs: number | null | undefined): number {
  const seconds = Math.round(Number(durationMs ?? 0) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, ACTIVE_VIEW_CAP_SECONDS);
}

export function bandForScore(score: number): EngagementBand {
  if (score >= ENGAGEMENT_BAND_THRESHOLDS.high) return "High";
  if (score >= ENGAGEMENT_BAND_THRESHOLDS.moderate) return "Moderate";
  return "Low";
}

export function computeEngagement(input: EngagementInput): EngagementResult {
  const activeSeconds = Math.max(0, Number(input.activeSeconds) || 0);
  const expectedWorkingDays = Math.max(1, Number(input.expectedWorkingDays) || 1);
  const distinctModules = Math.max(0, Number(input.distinctModules) || 0);
  const daysActive = Math.max(0, Number(input.daysActive) || 0);

  const activeMinutesPerWorkingDay = Math.round((activeSeconds / 60 / expectedWorkingDays) * 10) / 10;

  // No fallback branch: with no active time the usage term is 0, and only real
  // measured minutes move it.
  const usageScore = clamp01(activeMinutesPerWorkingDay / TARGET_MINUTES_PER_WORKING_DAY);
  const breadthScore = clamp01(distinctModules / BREADTH_TARGET);
  const regularityScore = clamp01(daysActive / expectedWorkingDays);

  const weighted =
    WEIGHTS.usage * usageScore +
    WEIGHTS.breadth * breadthScore +
    WEIGHTS.regularity * regularityScore;

  const score = Math.round(100 * clamp01(weighted));

  return {
    score,
    band: bandForScore(score),
    usageScore,
    breadthScore,
    regularityScore,
    activeMinutesPerWorkingDay,
  };
}
