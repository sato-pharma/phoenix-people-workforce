import assert from "node:assert/strict";

import { fieldWorkforceDeductionDayWeight } from "../src/lib/field-workforce-compliance/weekend-policy.ts";
import { earlyBirdsPeriodFromKey } from "../src/lib/early-birds/period.ts";
import {
  EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES,
  EARLY_BIRDS_GPS_QUALITY_FLOOR,
  EARLY_BIRDS_MIN_ACTIVE_DAYS,
  EARLY_BIRDS_MIN_EXPECTED_WORKING_DAYS,
  EARLY_BIRDS_REGULAR_PER_DAY_TARGET,
  EARLY_BIRDS_SCORING_VERSION,
  EARLY_BIRDS_VISITS_PER_DAY_TARGET,
  EARLY_BIRDS_WEIGHTS,
  buildEarlyBirdsRanking,
  earlyBirdsBaseScore,
  earlyBirdsFirstPlaceScore,
  earlyBirdsQualityWeight,
  earlyBirdsStartScore,
  isEarlyBirdsEligible,
  isPlausibleEarlyBirdsStart,
} from "../src/lib/early-birds/scoring.ts";
import type { EarlyBirdsRepContext, EarlyBirdsVisitFact } from "../src/lib/early-birds/types.ts";

// The Early Birds award policy. These constants and weights decide which rep is publicly crowned
// every fortnight, so they are pinned here deliberately: changing one is a business decision, and
// this file is what tells whoever changes it exactly what they moved.
//
// The property that matters most: GPS verification is a QUALITY WEIGHT, never a filter. Campaign
// visits cannot carry a GPS check-in by construction, so any design that treats missing GPS as
// disqualifying silently punishes real fieldwork.

const PERIOD = earlyBirdsPeriodFromKey("2026-08-H1"); // 1-15 Aug 2026

function rep(overrides: Partial<EarlyBirdsRepContext> = {}): EarlyBirdsRepContext {
  return {
    hrIdKey: "b100",
    hrId: "B-100",
    name: "Rep One",
    expectedWorkingDayWeight: 11,
    expectedWorkingDays: 12,
    activeAtPeriodEnd: true,
    ...overrides,
  };
}

function visit(overrides: Partial<EarlyBirdsVisitFact> = {}): EarlyBirdsVisitFact {
  return {
    hrIdKey: "b100",
    dateIso: "2026-08-03",
    startMinutes: 540, // 09:00
    timeSource: "gps_checkin",
    visitType: 0,
    gpsEligible: true,
    ...overrides,
  };
}

/** N visits spread one per day from the 1st, so `daysWithSubmission` is controllable. */
function visitsAcrossDays(count: number, overrides: Partial<EarlyBirdsVisitFact> = {}): EarlyBirdsVisitFact[] {
  return Array.from({ length: count }, (_unused, index) =>
    visit({ dateIso: `2026-08-${String(index + 1).padStart(2, "0")}`, ...overrides }),
  );
}


/**
 * Derives the GPS start map from fact-level startMinutes.
 *
 * The blocks below were written when a fact's own clock WAS the start time. Since 2026-08-09 the
 * ranking reads only real GPS check-ins (gpsStartByRepDay), so these fixtures state the same thing
 * the new way: "this rep verifiably started at this time on this day". Tests that care about the
 * absence of GPS call buildEarlyBirdsRanking directly instead.
 */
function gpsMapFrom(facts: readonly EarlyBirdsVisitFact[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const fact of facts) {
    // Same floor collect.ts applies before storing a check-in: an after-midnight clock is a
    // write-up, not an arrival, and must never become the day's start.
    if (!isPlausibleEarlyBirdsStart(fact.startMinutes)) continue;
    const key = `${fact.hrIdKey}|${fact.dateIso}`;
    const current = map.get(key);
    if (current === undefined || fact.startMinutes < current) map.set(key, fact.startMinutes);
  }
  return map;
}

function rank(input: Parameters<typeof buildEarlyBirdsRanking>[0]) {
  return buildEarlyBirdsRanking({ gpsStartByRepDay: gpsMapFrom(input.facts), ...input });
}

export function runEarlyBirdsScoringTests() {
  // ── Start score anchors ─────────────────────────────────────────────────────────
  {
    assert.equal(earlyBirdsStartScore(480), 1, "08:00 is a perfect start");
    assert.equal(earlyBirdsStartScore(720), 0, "12:00 scores nothing");
    assert.equal(earlyBirdsStartScore(600), 0.5, "10:00 is exactly halfway");
    assert.equal(earlyBirdsStartScore(400), 1, "earlier than 08:00 clamps, never exceeds 1");
    assert.equal(earlyBirdsStartScore(800), 0, "later than 12:00 clamps, never goes negative");
    assert.equal(earlyBirdsStartScore(null), 0, "no clock is not a good clock");
  }

  // ── Weights are a partition of 1.0 ──────────────────────────────────────────────
  {
    const sum = Object.values(EARLY_BIRDS_WEIGHTS).reduce((total, weight) => total + weight, 0);
    assert.equal(Math.round(sum * 1e6) / 1e6, 1, "weights must sum to exactly 1.00 or totalScore leaves [0,1]");
    assert.equal(earlyBirdsBaseScore({ start: 1, consistency: 1, regular: 1, volume: 1, firstPlace: 1 }), 1);
    assert.equal(earlyBirdsBaseScore({ start: 0, consistency: 0, regular: 0, volume: 0, firstPlace: 0 }), 0);
  }

  // ── GPS is a weight, and a Campaign-only rep is NOT punished ────────────────────
  {
    assert.equal(earlyBirdsQualityWeight(0), EARLY_BIRDS_GPS_QUALITY_FLOOR, "worst GPS record costs 15%, not the award");
    assert.equal(earlyBirdsQualityWeight(1), 1);
    assert.equal(earlyBirdsQualityWeight(0.5), 0.925);
    assert.equal(
      earlyBirdsQualityWeight(null),
      1,
      "a rep whose whole fortnight was Campaign work has NO gps-eligible visit — that is absence of evidence, not evidence of absence, and must not cost him anything",
    );
    assert.ok(earlyBirdsQualityWeight(0) > 0, "GPS can never zero a rep out — that would make it a filter");
  }

  // ── The two duels the weights were calibrated against ───────────────────────────
  {
    // A self-logs an unverifiable 07:00; B is GPS-corroborated at 09:00. Everything else equal.
    const aBase = earlyBirdsBaseScore({ start: 1, consistency: 0.6, regular: 0.6, volume: 0.6, firstPlace: 0.6 });
    const bBase = earlyBirdsBaseScore({ start: 0.75, consistency: 0.6, regular: 0.6, volume: 0.6, firstPlace: 0.6 });
    const aTotal = aBase * earlyBirdsQualityWeight(0);
    const bTotal = bBase * earlyBirdsQualityWeight(1);
    assert.equal(Math.round(aTotal * 1e6) / 1e6, 0.612);
    assert.equal(Math.round(bTotal * 1e6) / 1e6, 0.645);
    assert.ok(bTotal > aTotal, "the corroborated rep wins a near-tie — this is the anti-gaming property");

    // C is far better at everything but his GPS never matched; D is mediocre and fully verified.
    const cTotal = 0.95 * earlyBirdsQualityWeight(0);
    const dTotal = 0.7 * earlyBirdsQualityWeight(1);
    assert.ok(
      cTotal > dTotal,
      "a broken phone must not cost a rep a 36% performance lead — that is why the floor is 0.85 and not lower",
    );
  }

  // ── firstPlace never divides by zero ────────────────────────────────────────────
  {
    assert.equal(earlyBirdsFirstPlaceScore(0, 0), 0, "a fortnight with no contested day scores 0, never NaN");
    assert.ok(Number.isFinite(earlyBirdsFirstPlaceScore(3, 0)));
    assert.equal(earlyBirdsFirstPlaceScore(3, 6), 0.5);
  }

  // ── Campaign work counts fully everywhere except the GPS denominator ────────────
  {
    const shared = { reps: [rep({ hrIdKey: "reg", hrId: "B-1", name: "Regular Rep" }),
                            rep({ hrIdKey: "camp", hrId: "B-2", name: "Campaign Rep" })],
                     dailyWinnerHrIdKeys: new Map<string, string | null>() };
    const ranking = rank({
      period: PERIOD,
      reps: shared.reps,
      facts: [
        ...visitsAcrossDays(10, { hrIdKey: "reg", visitType: 0, gpsEligible: true, timeSource: "gps_checkin" }),
        ...visitsAcrossDays(10, { hrIdKey: "camp", visitType: -8, gpsEligible: false, timeSource: "save_time" }),
      ],
      dailyWinnerHrIdKeys: shared.dailyWinnerHrIdKeys,
    });
    const regular = ranking.scores.find((score) => score.hrIdKey === "reg");
    const campaign = ranking.scores.find((score) => score.hrIdKey === "camp");
    assert.ok(regular && campaign);
    assert.equal(campaign.gpsShare, null, "Campaign visits are not GPS-eligible, so there is no share to compute");
    assert.equal(campaign.qualityWeight, 1, "and therefore no penalty");
    assert.equal(
      campaign.components.start,
      regular.components.start,
      "Campaign work must contribute to start time identically",
    );
    assert.equal(campaign.components.consistency, regular.components.consistency, "and to consistency");
    assert.equal(campaign.components.volume, regular.components.volume, "and to volume");
    assert.equal(campaign.components.regular, 0, "only the Regular component differs — that IS the mechanism for valuing Regular work");
    assert.ok(regular.totalScore > campaign.totalScore, "so the Regular rep still wins, on merit rather than on GPS");
  }

  // ── A rep with zero GPS still scores, but can no longer WIN ────────────────────
  {
    // POLICY REVERSAL, owner decision 2026-08-09. This block previously asserted the opposite —
    // "GPS is a weight, not a filter" — and that was the right call while start times could come
    // from crm_save_date. Once the ranking clock became GPS-only (because save time is submission
    // time, running a median 57 min and a mean 307 min late on production), a rep with no check-in
    // has no start time at all, and you cannot crown the earliest starter on a person whose start
    // you never observed.
    //
    // The work is NOT erased: every visit still counts for volume, Regular, Campaign and
    // consistency, and the rep still appears on the board. What they lose is candidacy, with the
    // machine-readable reason `no_start_time_evidence` rather than a silent omission.
    // Raw call on purpose: no gpsStartByRepDay at all is exactly the situation under test.
    const ranking = buildEarlyBirdsRanking({
      period: PERIOD,
      reps: [rep()],
      facts: visitsAcrossDays(10, { timeSource: "save_time", gpsEligible: true }),
      dailyWinnerHrIdKeys: new Map(),
    });
    const score = ranking.scores[0];
    assert.equal(score.gpsShare, 0);
    assert.ok(score.totalScore > 0, "the work still scores — a missing check-in must never zero a rep's effort");
    assert.equal(score.gpsVerifiedDays, 0);
    assert.equal(
      score.eligible,
      false,
      "but with no verified start there is no candidacy — the award is specifically about start time",
    );
    assert.ok(
      score.ineligibleReasons.includes("no_start_time_evidence"),
      "and the reason is stated, never silent",
    );
  }

  // ── The minimum-days guard ──────────────────────────────────────────────────────
  {
    const ranking = rank({
      period: PERIOD,
      reps: [
        rep({ hrIdKey: "flash", hrId: "B-1", name: "Two Perfect Days" }),
        rep({ hrIdKey: "steady", hrId: "B-2", name: "Steady Rep" }),
      ],
      facts: [
        ...visitsAcrossDays(2, { hrIdKey: "flash", startMinutes: 420 }), // 07:00, flawless, twice
        ...visitsAcrossDays(9, { hrIdKey: "steady", startMinutes: 555 }), // 09:15, nine days
      ],
      dailyWinnerHrIdKeys: new Map(),
    });
    const flash = ranking.scores.find((score) => score.hrIdKey === "flash");
    assert.ok(flash);
    assert.equal(flash.eligible, false, "two brilliant mornings is not a fortnight");
    assert.ok(flash.ineligibleReasons.includes("insufficient_active_days"));
    assert.equal(
      ranking.candidates.some((candidate) => candidate.hrIdKey === "flash"),
      false,
      "and he must not be offered to the manager",
    );
    assert.equal(ranking.candidates[0]?.hrIdKey, "steady", "the steady rep is the recommendation");
    assert.ok(
      ranking.scores.some((score) => score.hrIdKey === "flash"),
      "but he is still SCORED and still shown, so 'why isn't he here' has an answer",
    );
    assert.equal(EARLY_BIRDS_MIN_ACTIVE_DAYS, 5);
  }

  // ── The coverage guard — the new hire the activity guard alone would miss ───────
  {
    const ranking = rank({
      period: PERIOD,
      // Hired on the 10th: only 5 expected working days in this fortnight.
      reps: [rep({ hrIdKey: "new", expectedWorkingDayWeight: 5, expectedWorkingDays: 5 })],
      facts: visitsAcrossDays(5, { hrIdKey: "new", startMinutes: 430 }),
      dailyWinnerHrIdKeys: new Map(),
    });
    const score = ranking.scores[0];
    assert.equal(score.components.consistency, 1, "5 of 5 days is a perfect consistency score…");
    assert.equal(score.eligible, false, "…but five days of a fortnight is not a fortnight");
    assert.ok(score.ineligibleReasons.includes("insufficient_period_coverage"));
    assert.equal(EARLY_BIRDS_MIN_EXPECTED_WORKING_DAYS, 8);
  }

  // ── Other ineligibility reasons ─────────────────────────────────────────────────
  {
    assert.deepEqual(
      isEarlyBirdsEligible({ daysWithSubmission: 0, expectedWorkingDays: 12, medianStartMinutes: null, activeAtPeriodEnd: true }).reasons.sort(),
      ["no_start_time_evidence", "no_submissions"],
      "a rep who submitted nothing is reported as such, not as merely 'insufficient'",
    );
    assert.equal(
      isEarlyBirdsEligible({ daysWithSubmission: 9, expectedWorkingDays: 12, medianStartMinutes: null, activeAtPeriodEnd: true })
        .reasons.includes("no_start_time_evidence"),
      true,
      "the award is about start time — crowning someone with no resolvable clock is indefensible",
    );
    assert.equal(
      isEarlyBirdsEligible({ daysWithSubmission: 9, expectedWorkingDays: 12, medianStartMinutes: 500, activeAtPeriodEnd: false })
        .reasons.includes("not_active_at_period_end"),
      true,
    );
  }

  // ── Ineligible reps always sort after eligible ones, whatever they scored ───────
  {
    const ranking = rank({
      period: PERIOD,
      reps: [
        rep({ hrIdKey: "flash", hrId: "B-1", name: "Aaa Flash" }),
        rep({ hrIdKey: "steady", hrId: "B-2", name: "Zzz Steady" }),
      ],
      facts: [
        ...visitsAcrossDays(2, { hrIdKey: "flash", startMinutes: 420 }),
        ...visitsAcrossDays(9, { hrIdKey: "steady", startMinutes: 700 }),
      ],
      dailyWinnerHrIdKeys: new Map(),
    });
    assert.equal(ranking.scores[0].hrIdKey, "steady", "an eligible rep outranks an ineligible one regardless of score");
    assert.equal(ranking.scores[1].eligible, false);
  }

  // ── Ranking is stable under input permutation ───────────────────────────────────
  {
    const reps = [
      rep({ hrIdKey: "a", hrId: "B-1", name: "Alpha" }),
      rep({ hrIdKey: "b", hrId: "B-2", name: "Bravo" }),
      rep({ hrIdKey: "c", hrId: "B-3", name: "Charlie" }),
    ];
    const facts = [
      ...visitsAcrossDays(8, { hrIdKey: "a", startMinutes: 540 }),
      ...visitsAcrossDays(8, { hrIdKey: "b", startMinutes: 540 }),
      ...visitsAcrossDays(8, { hrIdKey: "c", startMinutes: 540 }),
    ];
    const forward = rank({ period: PERIOD, reps, facts, dailyWinnerHrIdKeys: new Map() });
    const reversed = rank({
      period: PERIOD,
      reps: [...reps].reverse(),
      facts: [...facts].reverse(),
      dailyWinnerHrIdKeys: new Map(),
    });
    assert.deepEqual(
      forward.scores.map((score) => score.hrIdKey),
      reversed.scores.map((score) => score.hrIdKey),
      "three identical reps must rank by name, not by roster order — roster order here is achievement-sorted, so the fallback would rank the award by sales figures",
    );
    assert.deepEqual(forward.scores.map((score) => score.hrIdKey), ["a", "b", "c"]);
  }

  // ── The day key comes from visit_date, never from the timestamp ─────────────────
  {
    const ranking = rank({
      period: PERIOD,
      reps: [rep()],
      facts: [...visitsAcrossDays(5), visit({ dateIso: "2026-08-06", startMinutes: 545 })],
      dailyWinnerHrIdKeys: new Map(),
    });
    const score = ranking.scores[0];
    assert.equal(score.daysWithSubmission, 6);
    const sixth = score.timeline.find((day) => day.dateIso === "2026-08-06");
    assert.equal(sixth?.startMinutes, 545, "the visit lands on its own visit_date");
    const seventh = score.timeline.find((day) => day.dateIso === "2026-08-07");
    assert.equal(seventh?.startMinutes, null, "and never leaks its clock onto the following day");
  }

  // ── An after-midnight visit is still a submission on ITS OWN day ────────────────
  {
    const ranking = rank({
      period: PERIOD,
      reps: [rep()],
      // The 6th's work, written up at 00:30. It belongs to the 6th, and it is real work — but its
      // clock is not a start time.
      facts: [...visitsAcrossDays(5), visit({ dateIso: "2026-08-06", startMinutes: 30, timeSource: "save_time" })],
      dailyWinnerHrIdKeys: new Map(),
    });
    const score = ranking.scores[0];
    assert.equal(score.daysWithSubmission, 6, "the rep did submit on the 6th");
    const sixth = score.timeline.find((day) => day.dateIso === "2026-08-06");
    assert.equal(
      sixth?.startMinutes,
      null,
      "but 00:30 is a write-up of the day, not the moment it began — counting it would let a rep win the fortnight on paperwork",
    );
  }

  // ── Consistency uses the real weekend policy and caps at 1 ──────────────────────
  {
    // 2026-08-06 is a Thursday (half day) and 2026-08-07 a Friday (weekly off).
    assert.equal(fieldWorkforceDeductionDayWeight({ dateIso: "2026-08-07" }), 0, "Friday is a weekly off");
    assert.equal(fieldWorkforceDeductionDayWeight({ dateIso: "2026-08-06" }), 0.5, "Thursday is a half day");
    const ranking = rank({
      period: PERIOD,
      reps: [rep({ expectedWorkingDayWeight: 5.5, expectedWorkingDays: 6 })],
      facts: visitsAcrossDays(6),
      dailyWinnerHrIdKeys: new Map(),
    });
    assert.equal(
      ranking.scores[0].components.consistency,
      1,
      "6 submitted days against a 5.5 weighted expectation caps at 1.0, never 1.09",
    );
  }

  // ── Daily wins only count contested days ────────────────────────────────────────
  {
    const winners = new Map<string, string | null>([
      ["2026-08-01", "b100"],
      ["2026-08-02", null], // uncontested — nobody wins
      ["2026-08-03", "other"],
    ]);
    const ranking = rank({
      period: PERIOD,
      reps: [rep()],
      facts: visitsAcrossDays(8),
      dailyWinnerHrIdKeys: winners,
    });
    assert.equal(ranking.contestedDays, 2, "a day with no winner is not a day anyone could have won");
    assert.equal(ranking.scores[0].dailyWins, 1);
    assert.equal(ranking.scores[0].components.firstPlace, 0.5, "1 win of 2 contested days");
  }

  // ── An after-midnight save is paperwork, not a 02:25 start ──────────────────────
  {
    // Found on real production data: a rep whose Campaign visits were written up after midnight
    // scored a "median start" of 02:25 and a perfect start component, taking the district off a
    // colleague who genuinely started at 09:18 with eight daily wins.
    const ranking = rank({
      period: PERIOD,
      reps: [
        rep({ hrIdKey: "night", hrId: "B-1", name: "Night Filer" }),
        rep({ hrIdKey: "early", hrId: "B-2", name: "Real Early Riser" }),
      ],
      facts: [
        // Each day: one genuine 09:30 visit plus a 00:25 write-up of the previous day.
        ...visitsAcrossDays(8, { hrIdKey: "night", startMinutes: 570 }),
        ...visitsAcrossDays(8, { hrIdKey: "night", startMinutes: 25, visitType: -8, gpsEligible: false, timeSource: "save_time" }),
        ...visitsAcrossDays(8, { hrIdKey: "early", startMinutes: 500 }),
      ],
      dailyWinnerHrIdKeys: new Map(),
    });

    const night = ranking.scores.find((score) => score.hrIdKey === "night");
    const early = ranking.scores.find((score) => score.hrIdKey === "early");
    assert.ok(night && early);
    assert.equal(
      night.medianStartMinutes,
      570,
      "a 00:25 write-up must not become the day's start time — the day's start is the earliest PLAUSIBLE clock",
    );
    assert.equal(
      night.daysWithSubmission,
      8,
      "the after-midnight visit still counts as work: only its claim to be a start time is dropped",
    );
    assert.equal(night.totalVisits, 16, "and it still counts toward volume");
    assert.ok(
      early.totalScore > night.totalScore,
      "the rep who genuinely starts at 08:20 must beat the one whose earliest clock is a midnight write-up",
    );
    assert.equal(
      isPlausibleEarlyBirdsStart(EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES - 1),
      false,
      "04:59 is not a field start",
    );
    assert.equal(isPlausibleEarlyBirdsStart(EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES), true, "05:00 is the floor");
  }

  // ── A rep whose ONLY clocks are after midnight has no start-time evidence ───────
  {
    const ranking = rank({
      period: PERIOD,
      reps: [rep()],
      facts: visitsAcrossDays(9, { startMinutes: 40, timeSource: "save_time" }),
      dailyWinnerHrIdKeys: new Map(),
    });
    const score = ranking.scores[0];
    assert.equal(score.medianStartMinutes, null);
    assert.equal(score.components.start, 0);
    assert.equal(score.eligible, false, "the award is about start time; there is no evidence of one here");
    assert.ok(score.ineligibleReasons.includes("no_start_time_evidence"));
  }

  // ── The median is a whole minute ────────────────────────────────────────────────
  {
    const ranking = rank({
      period: PERIOD,
      reps: [rep()],
      // Even count -> the median averages two clocks; 665 and 668 average to 666.5.
      facts: [
        ...visitsAcrossDays(3, { startMinutes: 665 }),
        ...[4, 5, 6].map((day) =>
          visit({ dateIso: `2026-08-0${day}`, startMinutes: 668 }),
        ),
      ],
      dailyWinnerHrIdKeys: new Map(),
    });
    const value = ranking.scores[0].medianStartMinutes;
    assert.ok(value !== null && Number.isInteger(value), `median must be a whole minute, got ${String(value)} — a raw 666.5 renders as "11:6.5"`);
  }

  // ── Constant pinning: these values ARE the policy ───────────────────────────────
  {
    assert.deepEqual(EARLY_BIRDS_WEIGHTS, { start: 0.3, consistency: 0.25, regular: 0.2, volume: 0.15, firstPlace: 0.1 });
    assert.equal(EARLY_BIRDS_GPS_QUALITY_FLOOR, 0.85);
    assert.equal(EARLY_BIRDS_SCORING_VERSION, 1);
    assert.equal(
      EARLY_BIRDS_VISITS_PER_DAY_TARGET,
      13,
      "calibrated to the p75 of 816 real rep-days in 2026-07-H2 — set it below the median and every rep saturates, which silently deletes this component",
    );
    assert.equal(EARLY_BIRDS_REGULAR_PER_DAY_TARGET, 11, "p75 of Regular visits per rep-day over the same window");
  }

  // ── The ranking clock is GPS ONLY (owner decision 2026-08-09) ───────────────────
  {
    // Reported as "the timing captured is wrong and inaccurate for every medical rep". It was.
    // The old rule ranked on the earliest RESOLVED visit time, which falls back to crm_save_date
    // when no check-in matched — submission time, which this repo's own CRM master table labels
    // "paperwork time, NOT proof of being on site... often hours later or the next morning".
    // Measured on production: save time ran a median 57 min and a mean 307 min behind the GPS
    // check-in, and a quarter of rep-days were ranked on it while three quarters used GPS.
    const reps = [rep({ hrIdKey: "gps", hrId: "B-1", name: "Checked In" }),
                  rep({ hrIdKey: "paper", hrId: "B-2", name: "Paperwork Only" })];
    // Both submit the same work; only one has a check-in.
    const facts = [
      ...visitsAcrossDays(10, { hrIdKey: "gps", visitType: 0, gpsEligible: true, timeSource: "gps_checkin" }),
      ...visitsAcrossDays(10, { hrIdKey: "paper", visitType: 0, gpsEligible: true, timeSource: "save_time" }),
    ];
    const gpsStartByRepDay = new Map<string, number>();
    for (const fact of facts) {
      if (fact.hrIdKey === "gps") gpsStartByRepDay.set(`gps|${fact.dateIso}`, 8 * 60 + 30);
    }

    const ranking = buildEarlyBirdsRanking({
      period: PERIOD,
      reps,
      facts,
      dailyWinnerHrIdKeys: new Map<string, string | null>(),
      gpsStartByRepDay,
    });
    const gps = ranking.scores.find((score) => score.hrIdKey === "gps");
    const paper = ranking.scores.find((score) => score.hrIdKey === "paper");
    assert.ok(gps && paper);

    assert.equal(gps.medianStartMinutes, 8 * 60 + 30, "a GPS check-in is the start time");
    assert.equal(
      paper.medianStartMinutes,
      null,
      "a rep with visits but NO check-in has no start time — paperwork time must never be promoted into the ranking",
    );
    assert.equal(gps.gpsVerifiedDays, 10);
    assert.equal(paper.gpsVerifiedDays, 0);

    // Unverified is NOT the same as idle: the work still counts everywhere else.
    assert.equal(paper.totalVisits, gps.totalVisits, "the visits still count");
    assert.equal(paper.daysWithSubmission, gps.daysWithSubmission, "and so do the days worked");
    assert.equal(paper.components.consistency, gps.components.consistency);

    // Omitting the map entirely must not silently fall back to save time.
    const noMap = buildEarlyBirdsRanking({
      period: PERIOD,
      reps,
      facts,
      dailyWinnerHrIdKeys: new Map<string, string | null>(),
    });
    assert.equal(
      noMap.scores.every((score) => score.medianStartMinutes === null),
      true,
      "with no GPS data at all NOBODY has a verified start — the board shows an unranked field rather than ranking paperwork",
    );
  }
}
