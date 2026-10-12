// Phoenix Ranks — the five deeper measures, from the rep's own field saves. PURE: no database, no clock.
//
// OWNER, 2026-10-05: "I need more deeper metrics … the time between every visit and other, make a
// deep analytical mathematics … give a score about accuracy, about fraud detection. Every single data
// you can get from the Phoenix CRM." His answers the same day, each one ruled in chat:
//   * Time between visits, products per visit, visit notes and GPS precision join the score, each
//     worth exactly the same as the seven measures before them.
//   * Integrity joins the score too, and "admin sees detail": a rep reads one number, never a flag.
//   * The gap target is his own arithmetic: "calculate the distance in kilometer between each visit
//     and the other … how much time it will take [walking] … add from 10 to 30 minutes a waiting list
//     to enter to the doctor and the visit itself it takes from 5 to 10 minutes maximum … it will be
//     not accurate 100 percent but at least will be a reference".
//
// WALKING TIME IS ESTIMATED, NOT ASKED OF GOOGLE. Phoenix CRM calls no map service (geo.ts: "owner:
// never buy a map API"), and a nightly rebuild of five windows over every pair of visits would bill
// a route call per pair, every night. So the walk is the straight line between the two saves'
// fixes, times a road factor for Cairo's streets, at Google's own walking pace of 5 km/h.
//
// WHAT A "STOP" IS. Phoenix CRM files a pharmacy check beside a doctor visit as its own save, in the
// same minute (measured October 2026: the median gap from a PM visit to the pharmacy save after it
// is 0 minutes). That is one stop, not two, so a pharmacy save within a few minutes of a doctor visit
// is folded into it. And the AM-to-PM change is a shift break (median 196 minutes), never a gap.

import { distanceMeters } from "@/lib/phoenix-crm/geo";
// The settlement rule itself, pure, so this file stays pure: `readIntegritySettlement` is the same
// function the integrity board and the weekly fraud scan judge a settled case by.
import { readIntegritySettlement } from "@/lib/phoenix-crm/integrity-settlement";
import {
  COARSE_ACCURACY_METERS,
  PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS,
  PHOENIX_CRM_STRONG_INTEGRITY_FLAGS,
} from "@/lib/phoenix-crm/location-integrity";

/** One save the rep made in the field. Admin-keyed entries never reach here: they were not saved in the field. */
export type RankFieldSave = {
  repKey: string;
  /** The visit day (02:00 Cairo cut-off). */
  day: string;
  listType: "AM" | "PM" | "Pharmacy";
  /** The save instant, epoch milliseconds. */
  capturedAt: number;
  lat: number | null;
  lon: number | null;
  accuracyMeters: number | null;
  /** Products discussed (doctor visits). */
  products: number;
  /** A written comment or a voice note. */
  hasNote: boolean;
  /** The strong integrity flags the silent detectors put on this save, after the approximate-location rule. */
  integrityFlags: readonly string[];
};

/**
 * A strong integrity case filed against a PLACE the rep validated, rather than against a visit.
 *
 * 🔴 THE INTEGRITY PILLAR COUNTED ONLY VISIT CASES UNTIL 2026-10-12, so two whole detectors reached
 * nobody's score. `signboard` and `capture_trust` file against a place and never against a visit —
 * the signboard pass asks whether the sign on the building names the customer it was validated for,
 * and the capture-trust check judges a place's two readings against each other — so a rep whose
 * validation evidence did not hold up kept a clean Integrity score, while a rep flagged on one visit
 * lost marks for it.
 *
 * 🔴 AND IT IS A NUMERATOR, NEVER A DENOMINATOR. The score divides by field SAVES, and a place
 * validation is not a save: counting it in both halves would make a flagged place improve the ratio
 * of a rep who makes few visits. It is counted as one more thing the detectors found, against the
 * same number of saves — and `clamp100` already stops the score going below zero when a rep has more
 * cases than saves.
 */
export type RankPlaceCase = {
  repKey: string;
  /** The day the case was filed against, as the place filers write `visit_date`. */
  day: string;
  /** The strong flags, after the same settlement and approximate-location rules a visit case gets. */
  flags: readonly string[];
};

// ── The owner's gap model ───────────────────────────────────────────────────────────────────────
export const WALK_KMH = 5;
export const ROAD_FACTOR = 1.3;
export const WAIT_MINUTES = { min: 10, max: 30 } as const;
export const VISIT_MINUTES = { min: 5, max: 10 } as const;
/** Longer than this between two saves is a break (lunch, a hospital wait, the trip home), never scored. */
export const GAP_BREAK_MINUTES = 180;
/** A pharmacy save this close to a doctor visit is the same stop. */
export const COMPANION_SAVE_MINUTES = 3;
/** A distance between two fixes means something only when both fixes are this tight. */
export const GAP_FIX_MAX_METERS = 100;

// ── The other four ──────────────────────────────────────────────────────────────────────────────
/** Products per doctor visit for full marks. */
export const PRODUCTS_FULL_MARKS = 3;
/** A fix this tight is full marks; this loose or worse is none. */
export const GPS_FULL_METERS = 20;
export const GPS_ZERO_METERS = 200;
/**
 * Android's "approximate location" snaps to a grid and repeats its coordinate, so the precision flags
 * mean nothing on such a fix. The line and the list are Phoenix CRM's OWN (`COARSE_ACCURACY_METERS`,
 * `PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS` — the detector stops raising them there), never a second copy
 * here: a row written before that gate landed still carries them, and it must not cost a rep either.
 * Such a fix is marked down on GPS precision, never as dishonest.
 */
/** Each flagged save costs this many times its share: one in five flagged scores zero. */
export const INTEGRITY_PENALTY = 5;

export type RankGapFacts = {
  /** Pairs of consecutive stops that could be judged. */
  pairs: number;
  /** Sum of their 0-100 scores. */
  scoreSum: number;
  medianGapMinutes: number | null;
  /** Median walking minutes the model allowed between those stops. */
  medianWalkMinutes: number | null;
  /** Pairs faster than the model's floor, and slower than its ceiling. */
  tooFast: number;
  tooSlow: number;
};

export type RankQualityFacts = {
  gaps: RankGapFacts;
  /** Doctor visits (AM and PM) and the products discussed in them. */
  products: { visits: number; total: number };
  notes: { visits: number; withNote: number };
  gps: { fixes: number; scoreSum: number; medianMeters: number | null };
  integrity: {
    saves: number;
    flagged: number;
    /**
     * Strong cases filed against a PLACE this rep validated, inside the window. Counted alongside
     * `flagged` in the score and never added to `saves` — see `RankPlaceCase`.
     */
    places: number;
    flags: Record<string, number>;
  };
};

const clamp100 = (value: number): number => (value < 0 ? 0 : value > 100 ? 100 : value);
const round1 = (value: number): number => Math.round(value * 10) / 10;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Walking minutes between two points: the straight line times the road factor, at 5 km/h. */
export function walkingMinutes(meters: number): number {
  return ((meters * ROAD_FACTOR) / 1000 / WALK_KMH) * 60;
}

/** The band a gap should fall in: walk + the shortest wait and visit, to walk + the longest. */
export function expectedGapBand(meters: number): { floor: number; ceiling: number } {
  const walk = walkingMinutes(meters);
  return { floor: walk + WAIT_MINUTES.min + VISIT_MINUTES.min, ceiling: walk + WAIT_MINUTES.max + VISIT_MINUTES.max };
}

/**
 * One gap's score. Inside the band is full marks. Faster than the floor falls in proportion (half the
 * floor scores 50): the wait and the visit cannot both have happened. Slower than the ceiling falls
 * evenly to zero at the break line: time between doctors that the model cannot account for.
 */
export function gapScore(gapMinutes: number, meters: number): number {
  const { floor, ceiling } = expectedGapBand(meters);
  if (gapMinutes < floor) return clamp100((gapMinutes / floor) * 100);
  if (gapMinutes <= ceiling) return 100;
  if (ceiling >= GAP_BREAK_MINUTES) return 100;
  return clamp100(((GAP_BREAK_MINUTES - gapMinutes) / (GAP_BREAK_MINUTES - ceiling)) * 100);
}

/** A fix's 0-100 precision: 20 m or tighter is full marks, 200 m or worse is none. */
export function gpsScore(accuracyMeters: number): number {
  if (accuracyMeters <= GPS_FULL_METERS) return 100;
  return clamp100(((GPS_ZERO_METERS - accuracyMeters) / (GPS_ZERO_METERS - GPS_FULL_METERS)) * 100);
}

/** The strong flags that count against a save. Approximate-location artefacts are dropped; see above. */
export function countedIntegrityFlags(flags: readonly string[], accuracyMeters: number | null): string[] {
  const coarse = accuracyMeters !== null && accuracyMeters >= COARSE_ACCURACY_METERS;
  return flags.filter(
    (flag) =>
      (PHOENIX_CRM_STRONG_INTEGRITY_FLAGS as readonly string[]).includes(flag) &&
      !(coarse && (PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS as readonly string[]).includes(flag)),
  );
}

/**
 * The strong flags one integrity ROW costs a rep's rank — the approximate-location rule above, and
 * then the Super Admin's own settlement.
 *
 * 🔴 A SETTLED CASE COSTS THE REP NOTHING (owner, 2026-10-09: "make settling drop the rep-ranks
 * penalty too"). Settling is the Super Admin writing that a flag about a named person needs nothing
 * further, so a score that still carried it would have the board saying closed and the ladder saying
 * guilty about the same save in the same week. The weekly fraud scan already drops settled cases
 * (`loadIntegrityCasesForWindow`); this is the same rule reaching the one surface that turns a flag
 * into a NUMBER a manager reads — the integrity pillar and the admin twin's counts, which are the
 * same map.
 *
 * 🔴 AND IT UNSETTLES ITSELF, because the test is `settled_flags = flags` and nothing else. The
 * detectors upsert on (subject_kind, subject_id, source), so a fresh finding replaces `flags` in
 * place, the stored settlement stops describing the row, and the save is back in the score — with no
 * filer, and no rank job, taught that settling exists. Ranks are recomputed nightly for everybody,
 * so a case settled today leaves the score on the next run and never retro-rewrites a closed window.
 *
 * It is one exported function rather than a filter beside the query, so the rule can be broken in a
 * test and watched to fire. `readIntegritySettlement` is pure, and so is this.
 */
export function rankCountedFlags(row: {
  flags: readonly string[] | null;
  accuracyMeters: number | null;
  settledAt: unknown;
  settledBy: unknown;
  settledNote: unknown;
  settledFlags: unknown;
}): string[] {
  const flags = (row.flags ?? []).map((flag) => String(flag));
  const settled = readIntegritySettlement({
    settledAt: row.settledAt,
    settledBy: row.settledBy,
    settledNote: row.settledNote,
    settledFlags: row.settledFlags,
    flagsNow: flags,
  });
  if (settled) return [];
  return countedIntegrityFlags(flags, row.accuracyMeters);
}

const usableFix = (save: RankFieldSave): boolean =>
  save.lat !== null && save.lon !== null && save.accuracyMeters !== null && save.accuracyMeters <= GAP_FIX_MAX_METERS;

/** One day's stops in order: a pharmacy save beside a doctor visit is folded into it. */
export function stopsOfDay(saves: readonly RankFieldSave[]): RankFieldSave[] {
  const ordered = [...saves].sort((a, b) => a.capturedAt - b.capturedAt);
  const doctorTimes = ordered.filter((save) => save.listType !== "Pharmacy").map((save) => save.capturedAt);
  return ordered.filter(
    (save) =>
      save.listType !== "Pharmacy" ||
      !doctorTimes.some((at) => Math.abs(at - save.capturedAt) <= COMPANION_SAVE_MINUTES * 60_000),
  );
}

function gapFacts(saves: readonly RankFieldSave[]): RankGapFacts {
  const byDay = new Map<string, RankFieldSave[]>();
  for (const save of saves) byDay.set(save.day, [...(byDay.get(save.day) ?? []), save]);
  let pairs = 0;
  let scoreSum = 0;
  let tooFast = 0;
  let tooSlow = 0;
  const gaps: number[] = [];
  const walks: number[] = [];
  for (const daySaves of byDay.values()) {
    const stops = stopsOfDay(daySaves);
    for (let index = 1; index < stops.length; index += 1) {
      const before = stops[index - 1];
      const after = stops[index];
      // The AM-to-PM change is a shift break.
      if ((before.listType === "AM" && after.listType === "PM") || (before.listType === "PM" && after.listType === "AM")) continue;
      const gap = (after.capturedAt - before.capturedAt) / 60_000;
      if (gap > GAP_BREAK_MINUTES || !usableFix(before) || !usableFix(after)) continue;
      const meters = distanceMeters({ lat: before.lat!, lon: before.lon! }, { lat: after.lat!, lon: after.lon! });
      const { floor, ceiling } = expectedGapBand(meters);
      pairs += 1;
      scoreSum += gapScore(gap, meters);
      if (gap < floor) tooFast += 1;
      else if (gap > ceiling) tooSlow += 1;
      gaps.push(gap);
      walks.push(walkingMinutes(meters));
    }
  }
  const medianGap = median(gaps);
  const medianWalk = median(walks);
  return {
    pairs,
    scoreSum: round1(scoreSum),
    medianGapMinutes: medianGap === null ? null : round1(medianGap),
    medianWalkMinutes: medianWalk === null ? null : round1(medianWalk),
    tooFast,
    tooSlow,
  };
}

/**
 * The deeper facts for one rep's saves inside one window. The caller has already filtered to the rep
 * and the window — for the place cases as well as the saves.
 *
 * The place cases' flags land in the SAME `flags` breakdown the admin twin prints, so a signboard or
 * capture-trust finding is named there rather than hidden inside a number: the breakdown answers
 * "which check flagged how many", and a flag's own label already says which detector it came from.
 */
export function qualityFacts(saves: readonly RankFieldSave[], placeCases: readonly RankPlaceCase[] = []): RankQualityFacts {
  const doctorVisits = saves.filter((save) => save.listType !== "Pharmacy");
  const fixes = doctorVisits.filter((save) => save.accuracyMeters !== null).map((save) => save.accuracyMeters as number);
  const flags: Record<string, number> = {};
  let flagged = 0;
  for (const save of saves) {
    if (save.integrityFlags.length === 0) continue;
    flagged += 1;
    for (const flag of save.integrityFlags) flags[flag] = (flags[flag] ?? 0) + 1;
  }
  let places = 0;
  for (const place of placeCases) {
    if (place.flags.length === 0) continue;
    places += 1;
    for (const flag of place.flags) flags[flag] = (flags[flag] ?? 0) + 1;
  }
  const medianFix = median(fixes);
  return {
    gaps: gapFacts(saves),
    products: { visits: doctorVisits.length, total: doctorVisits.reduce((sum, save) => sum + save.products, 0) },
    notes: { visits: doctorVisits.length, withNote: doctorVisits.filter((save) => save.hasNote).length },
    gps: { fixes: fixes.length, scoreSum: round1(fixes.reduce((sum, meters) => sum + gpsScore(meters), 0)), medianMeters: medianFix === null ? null : round1(medianFix) },
    integrity: { saves: saves.length, flagged, places, flags },
  };
}

/** The five 0-100 scores. A measure with nothing to judge is null and stays out of the average. */
export function qualityScores(facts: RankQualityFacts): {
  visitGaps: number | null;
  productsPerVisit: number | null;
  visitNotes: number | null;
  gpsPrecision: number | null;
  integrity: number | null;
} {
  return {
    visitGaps: facts.gaps.pairs > 0 ? Math.round(clamp100(facts.gaps.scoreSum / facts.gaps.pairs)) : null,
    productsPerVisit:
      facts.products.visits > 0 ? Math.round(clamp100((facts.products.total / facts.products.visits / PRODUCTS_FULL_MARKS) * 100)) : null,
    visitNotes: facts.notes.visits > 0 ? Math.round(clamp100((facts.notes.withNote / facts.notes.visits) * 100)) : null,
    gpsPrecision: facts.gps.fixes > 0 ? Math.round(clamp100(facts.gps.scoreSum / facts.gps.fixes)) : null,
    // 🔴 THE NUMERATOR IS VISIT CASES PLUS PLACE CASES; THE DENOMINATOR IS SAVES ONLY. A place
    // validation is not a save, so adding it to both halves would let a flagged place IMPROVE the
    // ratio of a rep who makes few visits. And a rep with no saves at all stays null rather than
    // scoring zero off a place case: there is genuinely nothing to divide by, and a null measure
    // leaves the average instead of inventing a verdict out of one row.
    integrity:
      facts.integrity.saves > 0
        ? Math.round(
            clamp100((1 - (INTEGRITY_PENALTY * (facts.integrity.flagged + facts.integrity.places)) / facts.integrity.saves) * 100),
          )
        : null,
  };
}

export const EMPTY_QUALITY_FACTS: RankQualityFacts = {
  gaps: { pairs: 0, scoreSum: 0, medianGapMinutes: null, medianWalkMinutes: null, tooFast: 0, tooSlow: 0 },
  products: { visits: 0, total: 0 },
  notes: { visits: 0, withNote: 0 },
  gps: { fixes: 0, scoreSum: 0, medianMeters: null },
  integrity: { saves: 0, flagged: 0, places: 0, flags: {} },
};
