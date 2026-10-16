import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { certificateReasons, certificateSentence, rankCertificateHtml, type RankCertificateInput } from "../src/lib/rep-ranks/certificate.ts";
import { RANK_ADMIN_ROLES } from "../src/lib/rep-ranks/admin-audience.ts";
import { explainStanding, leverSentence } from "../src/lib/rep-ranks/explain.ts";
import { insigniaSvgInner } from "../src/lib/rep-ranks/insignia-svg.ts";
import { promotionSentence, rankForScore, RANK_LADDER, rollingScore, starCount } from "../src/lib/rep-ranks/ladder.ts";
import {
  countedIntegrityFlags,
  expectedGapBand,
  gapScore,
  gpsScore,
  qualityScores,
  rankCountedFlags,
  stopsOfDay,
  type RankFieldSave,
} from "../src/lib/rep-ranks/field-quality.ts";
import { factsForWindow, type RankRawData } from "../src/lib/rep-ranks/rank-facts.ts";
import {
  pillarScores,
  rankWindow,
  RANK_PILLARS,
  startScore,
  totalOf,
  type RankRepFacts,
} from "../src/lib/rep-ranks/scoring.ts";
import {
  isWindowClosed,
  monthSegments,
  quarterWindowOf,
  semesterWindowOf,
  weekStartOf,
  windowsForAnchor,
} from "../src/lib/rep-ranks/windows.ts";

// Phoenix Ranks (owner, 2026-10-05). What is pinned here, and why each matters:
//   * Phoenix CRM data ONLY — "all data in phoenix crm not ever any data from old crm";
//   * twelve measures, EQUAL weights, the total their mean — his answer, printed on the page — the
//     five deeper ones (time between visits, products, notes, GPS, integrity) added the same day;
//   * the gap model is his own: the walk, a 10-30 minute wait and a 5-10 minute visit;
//   * integrity is in the score but the rep never reads which check a save failed;
//   * AM and PM call rate are TWO pillars, never averaged ("this two and this ten");
//   * coverage and frequency are monthly ideas prorated to any duration ("it thinks monthly");
//   * AM start is a BONUS of up to 5 points that pressing can only ADD ("give it a bonus, but do not
//     make it zero for the whole AM"); field accuracy with nothing to judge is left OUT; every other
//     missing measure is a 0, never a free pass;
//   * the portal never receives the metrics column — "for the reps, only accuracy score";
//   * the day board never shows a Thursday or a Friday;
//   * the explanation is arithmetic a rep can check, and it never says "he".

function facts(overrides: Partial<RankRepFacts> & { hrIdKey: string }): RankRepFacts {
  return {
    repName: overrides.hrIdKey.toUpperCase(),
    lineName: "CNS",
    areaName: "Delta",
    regionName: null,
    owedDays: 20,
    targets: { am: 2, pm: 10 },
    amVisits: 40,
    pmVisits: 200,
    fieldDays: 20,
    coverage: { pct: 100, listed: 150, covered: 150 },
    frequency: { pct: 100, required: 300, met: 300 },
    plan: { planned: 240, kept: 240 },
    // No presses by default, so the totals below are the plain average of the seven measures.
    start: { medianMinutes: null, days: 0, scoreSum: 0 },
    accuracy: { located: 240, atPlace: 240 },
    // Full marks on every deeper measure by default.
    quality: {
      gaps: { pairs: 10, scoreSum: 1000, medianGapMinutes: 30, medianWalkMinutes: 5, tooFast: 0, tooSlow: 0 },
      products: { visits: 240, total: 720 },
      notes: { visits: 240, withNote: 240 },
      gps: { fixes: 240, scoreSum: 24000, medianMeters: 10 },
      integrity: { saves: 240, flagged: 0, places: 0, flags: {} },
    },
    ...overrides,
  };
}

export function runRepRanksTests() {
  // ── windows ──────────────────────────────────────────────────────────────────────────────────
  assert.equal(weekStartOf("2026-10-05"), "2026-10-03", "a Monday's week starts on the Saturday before");
  assert.equal(weekStartOf("2026-10-03"), "2026-10-03", "a Saturday starts its own week");
  assert.equal(weekStartOf("2026-10-09"), "2026-10-03", "a Friday closes the Saturday week");

  // Friday 9 Oct is the anchor: the day board must show Wednesday 7 Oct, never Thursday or Friday.
  const friday = windowsForAnchor("2026-10-09");
  assert.equal(friday[0].kind, "day");
  assert.equal(friday[0].key, "2026-10-07", "the day window is the last WORKING day (Sat-Wed)");
  // A holiday on Wednesday pushes it back to Tuesday.
  assert.equal(windowsForAnchor("2026-10-09", new Set(["2026-10-07"]))[0].key, "2026-10-06");

  const kinds = friday.map((window) => window.kind);
  assert.deepEqual(kinds, ["day", "week", "month", "quarter", "semester"]);
  assert.equal(quarterWindowOf("2026-10-04", "2026-10-04").key, "2026-Q4");
  assert.equal(semesterWindowOf("2026-10-04", "2026-10-04").key, "2026-S2");
  assert.equal(semesterWindowOf("2026-10-04", "2026-10-04").to, "2026-10-04", "a running window is scored through yesterday");
  assert.deepEqual(
    monthSegments("2026-09-26", "2026-10-02").map((segment) => segment.month),
    ["2026-09", "2026-10"],
    "a week across a month boundary is two month slices",
  );
  assert.equal(isWindowClosed("month", "2026-09-01", "2026-09-30"), true);
  assert.equal(isWindowClosed("month", "2026-10-01", "2026-10-04"), false, "a running month crowns nobody yet");

  // ── pillars and the total ────────────────────────────────────────────────────────────────────
  assert.equal(RANK_PILLARS.length, 13);
  assert.equal(RANK_PILLARS.filter((pillar) => !pillar.bonus).length, 12, "twelve equal measures — the pages say twelve");
  assert.deepEqual(RANK_PILLARS.filter((pillar) => pillar.bonus).map((pillar) => pillar.key), ["amStart"], "AM start is the one bonus");
  assert.ok(RANK_PILLARS.some((pillar) => pillar.key === "amStart"), "AM start time is its own pillar (owner, 2026-10-05)");
  assert.equal(startScore(8 * 60), 100);
  assert.equal(startScore(12 * 60), 0);
  assert.equal(startScore(10 * 60), 50);

  const perfect = pillarScores(facts({ hrIdKey: "a" }));
  assert.equal(totalOf(perfect), 100);

  // AM and PM stay two pillars: full AM cannot hide a weak PM (60 visits over 20 days against 10 a day).
  const weakPm = pillarScores(facts({ hrIdKey: "b", pmVisits: 60 }));
  assert.equal(weakPm.amCallRate, 100);
  assert.equal(weakPm.pmCallRate, 30);
  assert.equal(totalOf(weakPm), 94.17, "equal weights: the mean of the twelve measures");

  // Over-target is capped at 100 — a surplus never buys another pillar.
  assert.equal(pillarScores(facts({ hrIdKey: "c", amVisits: 100 })).amCallRate, 100);

  // AM START IS A BONUS: pressing by 08:00 every day adds 5; pressing at noon adds nothing; and NOT
  // pressing costs nothing beyond the bonus — the owner's ruling, after pressing had lowered a score.
  const earlyEveryDay = pillarScores(facts({ hrIdKey: "s1", pmVisits: 60, start: { medianMinutes: 480, days: 20, scoreSum: 2000 } }));
  assert.equal(earlyEveryDay.amStart, 100);
  assert.equal(totalOf(earlyEveryDay), 99.17);
  const noonEveryDay = pillarScores(facts({ hrIdKey: "s2", pmVisits: 60, start: { medianMinutes: 720, days: 20, scoreSum: 0 } }));
  assert.equal(totalOf(noonEveryDay), totalOf(weakPm), "a late press never lowers the score below not pressing");
  const halfTheDays = pillarScores(facts({ hrIdKey: "s3", pmVisits: 60, start: { medianMinutes: 480, days: 10, scoreSum: 1000 } }));
  assert.equal(totalOf(halfTheDays), 96.67,"a forgotten day only forgoes that day's share of the bonus");
  assert.equal(totalOf(pillarScores(facts({ hrIdKey: "s4", start: { medianMinutes: 480, days: 20, scoreSum: 2000 } }))), 100, "never above 100");

  // Nothing judged against a place is LEFT OUT (the mean is over eleven), never a 0.
  const unjudged = pillarScores(facts({ hrIdKey: "d", accuracy: { located: 0, atPlace: 0 }, pmVisits: 60 }));
  assert.equal(unjudged.fieldAccuracy, null);
  assert.equal(totalOf(unjudged), Math.round(((10 * 100 + 30) / 11) * 100) / 100);

  // No plan is NOT a free pass.
  assert.equal(pillarScores(facts({ hrIdKey: "e", plan: { planned: 0, kept: 0 } })).plan, 0);

  // ── the deeper measures (owner, 2026-10-05) ──────────────────────────────────────────────────
  // His gap model: walk + a 10-30 minute wait + a 5-10 minute visit. 1 km straight is 1.3 km of
  // street at 5 km/h: 15.6 minutes of walking.
  const band = expectedGapBand(1000);
  assert.equal(Math.round(band.floor * 10) / 10, 30.6);
  assert.equal(Math.round(band.ceiling * 10) / 10, 55.6);
  assert.equal(gapScore(25, 0), 100, "inside the band is full marks");
  assert.equal(gapScore(7.5, 0), 50, "half the floor: the wait and the visit cannot both have happened");
  assert.equal(gapScore(110, 0), 50, "halfway from the ceiling to the 3-hour break line");
  assert.equal(gpsScore(12), 100);
  assert.equal(gpsScore(110), 50);
  assert.equal(gpsScore(2000), 0, "Android's approximate location earns nothing on precision");
  // An honest phone on approximate location repeats a grid coordinate: marked down on precision, never as dishonest.
  assert.deepEqual(countedIntegrityFlags(["coordinate_replay", "constant_accuracy"], 2000), []);
  assert.deepEqual(countedIntegrityFlags(["coordinate_replay"], 12), ["coordinate_replay"]);
  // Phoenix CRM's own coarse line, not a second one here: a 600 m fix is already approximate.
  assert.deepEqual(countedIntegrityFlags(["coordinate_replay", "zero_jitter"], 600), [], "the coarse line is COARSE_ACCURACY_METERS");
  assert.deepEqual(countedIntegrityFlags(["mock_provider", "impossible_travel"], 2000), ["mock_provider", "impossible_travel"]);
  assert.deepEqual(countedIntegrityFlags(["constant_accuracy", "typed_coordinate"], 10), [], "weak flags never count on their own");

  // A case the Super Admin has SETTLED costs the rep's rank nothing (owner, 2026-10-09). The test is
  // `settled_flags = flags` and nothing else, so a settlement the detectors have overtaken counts
  // again by itself — no filer and no rank job knows settling exists.
  const flagged = { accuracyMeters: 12, flags: ["mock_provider"] };
  const unsettled = { settledAt: null, settledBy: null, settledFlags: null, settledNote: null };
  const settledOn = (flags: string[]) => ({
    settledAt: "2026-10-09T18:00:00.000Z",
    settledBy: "B-10",
    settledFlags: flags,
    settledNote: "The sign was replaced the week before; the reading was of the new one.",
  });
  assert.deepEqual(rankCountedFlags({ ...flagged, ...unsettled }), ["mock_provider"], "an unsettled case still costs the rank");
  assert.deepEqual(rankCountedFlags({ ...flagged, ...settledOn(["mock_provider"]) }), [], "a settled case costs the rank nothing");
  assert.deepEqual(
    rankCountedFlags({ ...flagged, flags: ["mock_provider", "impossible_travel"], ...settledOn(["mock_provider"]) }),
    ["mock_provider", "impossible_travel"],
    "a NEW finding on a settled subject reopens the penalty — the flags no longer match what was settled",
  );
  assert.deepEqual(
    rankCountedFlags({ ...flagged, ...settledOn(["mock_provider"]), settledNote: null }),
    ["mock_provider"],
    "a half-written settlement is no settlement — it must not quietly clear a penalty",
  );
  // The settlement never overrides the approximate-location rule in the other direction either.
  assert.deepEqual(
    rankCountedFlags({ accuracyMeters: 2000, flags: ["coordinate_replay"], ...unsettled }),
    [],
    "the coarse-fix rule still drops a precision artefact with no settlement in sight",
  );

  assert.equal(
    qualityScores({ ...facts({ hrIdKey: "q" }).quality, integrity: { saves: 20, flagged: 1, places: 0, flags: { mock_provider: 1 } } }).integrity,
    75,
    "each flagged save costs five times its share",
  );
  // A strong case against a PLACE he validated costs the same, on the same denominator (2026-10-12).
  assert.equal(
    qualityScores({ ...facts({ hrIdKey: "q" }).quality, integrity: { saves: 20, flagged: 0, places: 1, flags: { sign_other_name: 1 } } })
      .integrity,
    75,
    "a flagged place costs what a flagged save costs — the signboard and capture-trust detectors reach the score",
  );
  // And a rep with nothing to divide by stays NULL rather than scoring zero off one place case.
  assert.equal(
    qualityScores({ ...facts({ hrIdKey: "q" }).quality, integrity: { saves: 0, flagged: 0, places: 1, flags: { sign_other_name: 1 } } })
      .integrity,
    null,
    "no field save means no ratio — a measure with nothing to judge leaves the average",
  );
  const integrityPillar = RANK_PILLARS.find((pillar) => pillar.key === "integrity");
  assert.ok(integrityPillar && !integrityPillar.bonus, "integrity is in the score");
  assert.doesNotMatch(integrityPillar.explains, /mock|replay|jitter|fake|spoof|coordinate|travel/i, "the rep never learns which check exists");

  // ── ranking ──────────────────────────────────────────────────────────────────────────────────
  const standings = rankWindow(
    [
      facts({ hrIdKey: "x1", repName: "Aya", lineName: "CNS" }),
      facts({ hrIdKey: "x2", repName: "Bassem", lineName: "Pedia", pmVisits: 160 }),
      facts({ hrIdKey: "x3", repName: "Dina", lineName: "CNS", pmVisits: 60 }),
      facts({ hrIdKey: "x4", repName: "Omar", lineName: "CNS", fieldDays: 3 }),
    ],
    "month",
  );
  assert.deepEqual(standings.map((standing) => standing.repName), ["Aya", "Bassem", "Dina", "Omar"]);
  assert.equal(standings[0].companyPosition, 1);
  assert.equal(standings[2].companyPosition, 3);
  assert.equal(standings[2].linePosition, 2, "Dina is #2 in CNS behind Aya, whatever Pedia does");
  assert.equal(standings[1].linePosition, 1, "Bassem leads Pedia");
  assert.equal(standings[3].ranked, false, "three days in a month is too few to rank fairly");
  assert.equal(standings[3].unrankedReason, "too_few_days");
  assert.equal(standings[3].companyCount, 3);
  // A rep who owed only two days in the window is held to two, never to the month's five.
  const shortWindow = rankWindow([facts({ hrIdKey: "y1", owedDays: 2, fieldDays: 2, amVisits: 4, pmVisits: 20 })], "month");
  assert.equal(shortWindow[0].ranked, true);

  // ── explanation ──────────────────────────────────────────────────────────────────────────────
  const dina = explainStanding(standings[2], standings);
  assert.equal(dina.headline, "You are #3 of 3 in the company.");
  assert.equal(dina.levers[0].pillar, "pmCallRate");
  assert.equal(dina.levers[0].totalGain, 5.8, "70 points of PM over twelve measures is 5.8 on the total");
  assert.equal(dina.levers[0].wouldReachPosition, 1, "closing PM alone ties the leader and the tie-break is PM");
  assert.match(leverSentence(dina.levers[0]), /Raising PM call rate from 30 to 100 adds 5\.8 points/);
  assert.match(leverSentence({ ...dina.levers[0], totalGain: 1 }), /adds 1 point to your score/, "one point is singular");
  const startLever = dina.levers.find((lever) => lever.pillar === "amStart");
  assert.equal(startLever?.totalGain, 5, "the whole AM start bonus is 5 points");
  assert.ok(dina.lines.some((line) => line.startsWith("Where #1 is ahead: PM call rate 30 against 100")));
  assert.ok(dina.lines.some((line) => line.includes("the average of 12 measures, each worth the same (one twelfth of the average)")));
  // The bonus is always read in the points it adds — never as a 0-100 score beside the real measures.
  assert.match(leverSentence(startLever!), /^Pressing I started working by 08:00 on every working day adds 5 points to your score\./);
  const pressing = rankWindow(
    [
      facts({ hrIdKey: "e1", repName: "Early", start: { medianMinutes: 480, days: 20, scoreSum: 2000 } }),
      facts({ hrIdKey: "e2", repName: "Late", pmVisits: 160, start: { medianMinutes: 600, days: 10, scoreSum: 500 } }),
    ],
    "month",
  );
  const latePresser = explainStanding(pressing[1], pressing);
  assert.ok(
    latePresser.lines.includes("Where #1 is ahead: PM call rate 80 against 100 · AM start bonus +1.3 against +5.0 of 5."),
    `the bonus reads as points: ${latePresser.lines.join(" | ")}`,
  );
  const early = explainStanding(pressing[0], pressing);
  assert.ok(!early.strengths.some((strength) => strength.startsWith("AM start")), "the bonus is not a measure, so never a strength");
  const aya = explainStanding(standings[0], standings);
  assert.equal(aya.headline, "You are #1 of 3 in the company.");
  for (const sentence of [...dina.lines, ...aya.lines, dina.headline, promotionSentence(77), ...RANK_PILLARS.map((p) => p.explains)]) {
    assert.doesNotMatch(sentence, /\b(he|his|him)\b/i, `neutral wording: "${sentence}"`);
  }

  // ── ladder and stars ─────────────────────────────────────────────────────────────────────────
  assert.equal(rankForScore(null).english, "Private");
  assert.equal(rankForScore(75.9).english, "First Lieutenant");
  assert.equal(rankForScore(76).english, "Captain");
  assert.equal(rankForScore(100).english, "Major General");
  assert.equal(RANK_LADDER[0].arabic, "جندي");
  assert.equal(RANK_LADDER[RANK_LADDER.length - 1].arabic, "لواء");
  for (let index = 1; index < RANK_LADDER.length; index += 1) {
    assert.ok(RANK_LADDER[index].minScore > RANK_LADDER[index - 1].minScore, "the ladder only climbs");
  }
  assert.equal(rollingScore([80, null, 70, 60, 10]), 70, "the newest three RANKED months");
  assert.match(promotionSentence(78.4), /Major \(رائد\) begins at 82: 3\.6 points to promotion/);
  assert.equal(
    starCount([
      { windowKind: "day", windowKey: "d", windowLabel: "d", scope: "company" },
      { windowKind: "week", windowKey: "w", windowLabel: "w", scope: "company" },
      { windowKind: "month", windowKey: "m", windowLabel: "m", scope: "line" },
      { windowKind: "quarter", windowKey: "q", windowLabel: "q", scope: "company" },
    ]),
    2,
    "a star is a month, quarter or semester title — day and week wins are medals",
  );

  // ── facts from Phoenix CRM's own rows ─────────────────────────────────────────────────────────
  // October 2026 holds 22 working days (Sat-Wed). Window = Sat 3 Oct to Fri 9 Oct; the rep started
  // on 3 Oct and was on approved leave on Tue 6 Oct. Owed: Sat 3, Sun 4, Mon 5, Wed 7 = 4 days.
  const visit = (day: string, customerId: string, listType: "AM" | "PM", located = true, atPlace = true) => ({
    repKey: "r1",
    seatId: "S1",
    customerId,
    listType,
    day,
    located,
    atPlace,
  });
  const doctors = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"];
  // 3 Oct, Cairo evening. 0.0045 degrees of latitude is about 500 m.
  const t0 = Date.UTC(2026, 9, 3, 15, 0);
  const minute = 60_000;
  const save = (
    day: string,
    listType: RankFieldSave["listType"],
    at: number,
    lat: number,
    accuracyMeters: number,
    products: number,
    hasNote: boolean,
    integrityFlags: string[] = [],
  ): RankFieldSave => ({ repKey: "r1", day, listType, capturedAt: at, lat, lon: 31, accuracyMeters, products, hasNote, integrityFlags });
  const saves: RankFieldSave[] = [
    save("2026-10-03", "AM", t0 - 100 * minute, 30, 10, 2, true), // the AM shift, 100 minutes before: AM to PM is a break, never a gap
    save("2026-10-03", "PM", t0, 30, 10, 2, true),
    save("2026-10-03", "Pharmacy", t0 + minute, 30, 10, 0, false), // the pharmacy check beside it: the same stop
    save("2026-10-03", "PM", t0 + 25 * minute, 30.0045, 15, 3, false), // 500 m on, 25 minutes later: inside the band
    save("2026-10-03", "PM", t0 + 30 * minute, 30.0045, 50, 1, true, ["mock_provider"]), // 5 minutes later, same door: too fast
    save("2026-10-04", "AM", t0 + 1080 * minute, 30, 2000, 0, false),
    save("2026-10-04", "PM", t0 + 1620 * minute, 30, 10, 3, true),
    save("2026-10-04", "PM", t0 + 1830 * minute, 30, 10, 3, true), // 210 minutes later: a break, not scored
  ];
  assert.equal(stopsOfDay(saves.filter((entry) => entry.day === "2026-10-03")).length, 4, "the companion pharmacy save folds into its visit");
  const raw: RankRawData = {
    roster: [{ hrIdKey: "r1", repName: "Aya", lineName: "CNS", areaName: "Delta", regionName: null, seatIds: ["S1"], startDay: "2026-10-03" }],
    saves,
    placeCases: [],
    visits: [
      visit("2026-10-03", "d1", "PM"),
      visit("2026-10-03", "d1", "PM", true, false),
      visit("2026-10-03", "p1", "AM"),
      visit("2026-10-04", "d2", "PM", false, false),
      visit("2026-10-06", "d3", "PM"), // on leave: not owed, so not in the call rate
      visit("2026-10-08", "d4", "PM"), // Thursday: not a working day
    ],
    customers: [
      ...doctors.map((id) => ({ id, seatId: "S1", listType: "PM" as const, grade: "A", active: true, statusChangedDay: null })),
      { id: "p1", seatId: "S1", listType: "AM", grade: "B", active: true, statusChangedDay: null },
      { id: "gone", seatId: "S1", listType: "PM", grade: "A", active: false, statusChangedDay: "2026-09-10" },
    ],
    planDays: [
      { seatId: "S1", day: "2026-10-03", planned: 4, kept: 3 },
      { seatId: "S1", day: "2026-10-04", planned: 4, kept: 1 },
    ],
    starts: new Map([["r1", new Map([["2026-10-03", 9 * 60], ["2026-10-04", 10 * 60], ["2026-10-05", 11 * 60]])]]),
    leave: new Set(["r1|2026-10-06"]),
    holidays: new Set<string>(),
    gradeTargets: { AM: { A: 1, B: null, C: null }, PM: { A: 3, B: 2, C: 1 } },
    callRateTargets: { am: 2, pm: 10 },
  };
  const [week] = factsForWindow(raw, { from: "2026-10-03", to: "2026-10-09" });
  assert.equal(week.owedDays, 4, "leave, Thursday and Friday are not owed");
  assert.equal(week.pmVisits, 3, "the leave-day and Thursday visits stay out of the call rate");
  assert.equal(week.amVisits, 1);
  assert.equal(week.fieldDays, 2);
  assert.equal(week.coverage?.listed, 11, "a customer dropped before the month is off the list");
  assert.equal(week.coverage?.covered, 5, "every visit that week covers its customer, Thursday's included");
  assert.equal(week.coverage?.pct, 100, "a week's pace is 4 of 22 working days; 5 of 11 seen is above it");
  assert.ok(week.frequency && week.frequency.pct > 0 && week.frequency.pct < 100, "frequency is prorated, never a free 100");
  assert.deepEqual(week.plan, { planned: 8, kept: 4 });
  assert.equal(week.start.medianMinutes, 10 * 60, "the median press");
  assert.deepEqual(week.accuracy, { located: 5, atPlace: 4 }, "a visit with no place to judge is left out");
  const weekScores = pillarScores(week);
  assert.equal(weekScores.pmCallRate, 8, "3 PM visits over 4 owed days against 10 a day");
  assert.equal(week.start.scoreSum, 150, "three presses on owed days: 09:00, 10:00, 11:00 score 75 + 50 + 25");
  assert.equal(weekScores.amStart, 38, "150 over 4 owed days: a day without a press earns nothing");
  assert.equal(weekScores.fieldAccuracy, 80);
  assert.equal(week.quality.gaps.pairs, 2, "AM to PM, the pharmacy beside a visit and a 3-hour break are not gaps");
  assert.equal(week.quality.gaps.tooFast, 1);
  assert.equal(weekScores.visitGaps, 67, "100 and 33 over two gaps");
  assert.equal(weekScores.productsPerVisit, 67, "14 products over 7 doctor visits, against 3 a visit");
  assert.equal(weekScores.visitNotes, 71, "5 of 7 doctor visits carry a note");
  assert.equal(weekScores.gpsPrecision, 83);
  assert.deepEqual(week.quality.integrity, { saves: 8, flagged: 1, places: 0, flags: { mock_provider: 1 } });
  assert.equal(weekScores.integrity, 38, "one flagged save of eight costs five eighths");

  // ── a strong case against a PLACE he validated costs exactly what a flagged visit costs ───────
  // 🔴 THE PILLAR COUNTED VISIT CASES ONLY UNTIL 2026-10-12, so `signboard` and `capture_trust` —
  // which file against a place and never against a visit — reached nobody's score at all. Here the
  // visit flag is removed and one place case put in its stead: same rep, same week, same eight
  // saves, and the score must land on the same 38. Before the fix this read 100.
  const placeCaseWeek = factsForWindow(
    {
      ...raw,
      saves: saves.map((entry) => ({ ...entry, integrityFlags: [] })),
      placeCases: [
        { repKey: "r1", day: "2026-10-03", flags: ["sign_other_name"] },
        // Outside the window: a case is counted against the day it was filed for, exactly as a visit
        // case is, so this one must not reach the week.
        { repKey: "r1", day: "2026-10-20", flags: ["sign_other_name"] },
        // Another rep's case must never land on his row.
        { repKey: "r2", day: "2026-10-03", flags: ["sign_other_name"] },
      ],
    },
    { from: "2026-10-03", to: "2026-10-09" },
  )[0];
  assert.deepEqual(
    placeCaseWeek.quality.integrity,
    { saves: 8, flagged: 0, places: 1, flags: { sign_other_name: 1 } },
    "one place case in the window, counted and named — the other rep's and the later day's stay out",
  );
  assert.equal(
    qualityScores(placeCaseWeek.quality).integrity,
    38,
    "a flagged place costs the same as a flagged visit — it is a numerator, and the denominator stays field saves",
  );
  // 🔴 A NUMERATOR, NEVER A DENOMINATOR. Counting the place among the saves as well would read
  // 1 - 5/9 = 44 and make a flagged place IMPROVE a rep who makes few visits.
  assert.notEqual(qualityScores(placeCaseWeek.quality).integrity, 44, "a place case must never be added to the saves it is divided by");
  // A whole month at full pace is Phoenix CRM's own coverage figure: 5 of 11.
  const [month] = factsForWindow(
    { ...raw, leave: new Set<string>(), roster: [{ ...raw.roster[0], startDay: "2026-10-01" }] },
    { from: "2026-10-01", to: "2026-10-31" },
  );
  assert.equal(month.coverage?.pct, Math.round((5 / 11) * 100 * 100) / 100);
  // A rep who started on Monday owes nothing before it.
  const [late] = factsForWindow({ ...raw, roster: [{ ...raw.roster[0], startDay: "2026-10-05" }] }, { from: "2026-10-03", to: "2026-10-09" });
  assert.equal(late.owedDays, 2);
  assert.equal(late.amVisits + late.pmVisits, 0);
  // A rep who has not started by the window's end is not on that window at all.
  assert.equal(factsForWindow({ ...raw, roster: [{ ...raw.roster[0], startDay: "2026-10-10" }] }, { from: "2026-10-03", to: "2026-10-09" }).length, 0);

  // ── the insignia: one drawing, every rank distinct ────────────────────────────────────────────
  const drawings = RANK_LADDER.map((rank) => insigniaSvgInner(rank.insignia));
  assert.equal(new Set(drawings).size, RANK_LADDER.length, "every rank draws its own insignia (owner: \"distinguish one rank from another\")");
  const insigniaComponent = readFileSync(new URL("../src/components/rep-ranks/rank-insignia.tsx", import.meta.url), "utf8");
  assert.ok(insigniaComponent.includes("insigniaSvgInner(rank.insignia)"), "the board draws the same insignia the certificate prints");

  // ── the certificate (owner, 2026-10-05: "export a premium polished PDF") ──────────────────────
  const certificate: RankCertificateInput = {
    repName: "Dina Samir",
    lineName: "CNS",
    areaName: "Delta",
    kind: "month",
    windowLabel: "October 2026",
    closed: false,
    total: 94.17,
    companyPosition: 3,
    companyCount: 11,
    linePosition: 2,
    lineCount: 4,
    pillars: standings[2].pillars,
    rank: rankForScore(78.4),
    rollingScore: 78.4,
    stars: 2,
    titles: [
      { windowKind: "month", windowKey: "2026-09", windowLabel: "September 2026", scope: "line" },
      { windowKind: "week", windowKey: "2026-09-26", windowLabel: "26 Sep 2026", scope: "company" },
    ],
    leaderTotal: 100,
    runnerUpTotal: 98.33,
    issuedLabel: "5 October 2026",
    photoDataUri: null,
    initials: "DS",
  };
  assert.equal(
    certificateSentence(certificate),
    "A medical representative on the CNS line in Delta, ranked 3rd of 11 across the company on Phoenix Ranks for October 2026 so far.",
  );
  const reasons = certificateReasons(certificate);
  assert.ok(reasons[0].startsWith("A score of 94.2: the average of 12 Phoenix CRM measures"), reasons[0]);
  assert.ok(reasons.includes("5.8 points behind the company's first place."), reasons.join(" | "));
  assert.ok(reasons.includes("2nd of 4 on the CNS line."));
  assert.ok(reasons.includes("Most room to grow: PM call rate at 30."), reasons.join(" | "));
  assert.ok(
    certificateReasons({ ...certificate, companyPosition: 1, total: 100 }).includes("First in the company, 1.7 points ahead of the next rep."),
  );
  const certificateHtml = rankCertificateHtml(certificate);
  for (const expected of ["Dina Samir", "This certificate recognises", certificate.rank.arabic, "94.2", "Why this place", "Titles held", "SATO-DIS-2026-01 v1.0", "Place in the company"]) {
    assert.ok(certificateHtml.includes(expected), `the certificate prints ${expected}`);
  }
  for (const pillar of RANK_PILLARS) assert.ok(certificateHtml.includes(pillar.label), `the snapshot shows ${pillar.label}`);
  for (const sentence of [certificateSentence(certificate), ...reasons]) {
    assert.doesNotMatch(sentence, /\b(he|his|him|she|her)\b/i, `neutral wording: "${sentence}"`);
  }
  assert.ok(!rankCertificateHtml({ ...certificate, repName: "<b>x</b>" }).includes("<b>x</b>"), "a name is escaped, never markup");
  // The portrait (owner, 2026-10-06: "add his picture"): the photograph when there is one, the
  // initials plate when there is not, and never anything but an inlined image as the source.
  const photo = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  assert.ok(rankCertificateHtml({ ...certificate, photoDataUri: photo }).includes(`<img src="${photo}"`), "the certificate prints the rep's photograph");
  assert.ok(certificateHtml.includes('<span class="rc-portrait__mono">DS</span>'), "no photograph prints the initials plate");
  assert.ok(
    !rankCertificateHtml({ ...certificate, photoDataUri: 'x" onerror="alert(1)' }).includes("onerror"),
    "a portrait source that is not an inlined image is never printed",
  );
  // Self only on the portal: the route refuses another rep's certificate to anyone outside the admin twin's audience.
  const certificateRoute = readFileSync(new URL("../app/api/rep-ranks/certificate/route.ts", import.meta.url), "utf8");
  assert.match(certificateRoute, /if \(requested !== own && !mayCertifyAnyone\)/);
  assert.match(certificateRoute, /assertPermission\(access, "early_birds", "read"\)/);
  // The page and the route read ONE audience: HR Resourcing could open /admin/ranks while the route's own shorter list
  // answered its certificate button 403, which the browser saved as certificate.json.
  const adminRanksPage = readFileSync(new URL("../app/(admin)/admin/ranks/page.tsx", import.meta.url), "utf8");
  assert.match(certificateRoute, /RANK_ADMIN_ROLES\.has\(access\.role\)/, "the certificate route reads the shared admin audience");
  assert.match(adminRanksPage, /RANK_ADMIN_ROLES\.has\(access\.role\)/, "the admin page reads the shared admin audience");
  assert.ok(!/new Set\(\["Super Admin"/.test(certificateRoute + adminRanksPage), "neither file keeps a private role list");
  assert.ok(RANK_ADMIN_ROLES.has("HR Resourcing"), "the Talent Acquisition seat may print any rep's certificate");
  const certificateServer = readFileSync(new URL("../src/lib/rep-ranks/server/certificate-pdf.ts", import.meta.url), "utf8");
  assert.match(certificateServer, /audience: "portal"/, "the certificate reads scores only, never the metrics");

  // ── Phoenix CRM only ──────────────────────────────────────────────────────────────────────────
  const compute = readFileSync(new URL("../src/lib/rep-ranks/server/compute.ts", import.meta.url), "utf8");
  const facts2 = readFileSync(new URL("../src/lib/rep-ranks/rank-facts.ts", import.meta.url), "utf8");
  for (const source of [compute, facts2]) {
    for (const forbidden of ["kpis-board", "kpis-trend", "early-birds", "crm_visits", "ireports360-"]) {
      assert.ok(!source.includes(forbidden), `Phoenix Ranks never reads the old CRM: ${forbidden}`);
    }
  }
  assert.ok(compute.includes('.from("phoenix_crm_countable_visits")'), "the visits are Phoenix CRM's countable visits");
  assert.ok(compute.includes('.from("phoenix_crm_location_integrity")'), "integrity is Phoenix CRM's own silent detectors");
  assert.ok(compute.includes('row.capture_source === "admin"'), "an admin-keyed entry never reaches the deeper measures");

  // A settled case can only drop out of the score if the READ actually asks for the four columns the
  // rule is judged on — the pure function cannot prove that, and a PostgREST select is a string the
  // compiler never checks. Comments are stripped first (the shared lexer, never a line-wise strip):
  // this file's own prose names `settled_flags`, which would satisfy a raw-source pin for nothing.
  const computeCode = stripComments(compute);
  const integritySelect = /\.from\("phoenix_crm_location_integrity"\)\s*\.select\(([^)]*)\)/.exec(computeCode)?.[1] ?? "";
  for (const column of ["settled_at", "settled_by", "settled_note", "settled_flags"]) {
    assert.ok(integritySelect.includes(column), `the integrity read must select ${column} — a settled case cannot be seen without it`);
  }
  // 🔴 EVERY PER-REP KEY IN THIS FILE GOES THROUGH `keyOf` — the roster, the saves, the starts and
  // the place cases. The roster is keyed by `normalizeHrIdForAccess`, which lower-cases and strips
  // every dash, so an upper-cased raw `rep_hr_id` ("AI-0020", "B-170") matches NO rep and the case
  // lands on nobody. The place reader did exactly that from the day the pillar was widened, and the
  // fixtures above could never see it: they hand canonical keys straight to the pure function, so
  // the reader's own key is the one thing only the source can pin.
  const repKeyAssignments = [...computeCode.matchAll(/const repKey = ([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(repKeyAssignments.length >= 4, "the per-rep readers are still here to check");
  for (const assignment of repKeyAssignments) {
    assert.ok(
      assignment.startsWith("keyOf("),
      `every per-rep key goes through keyOf, the roster's own normalizer — an upper-cased HR id matches no rep on the roster: ${assignment}`,
    );
  }

  // 🔴 A CASE A LATER READING HAS WITHDRAWN COSTS THE RANK NOTHING — THE BOARD AND THE PILLAR MUST
  // AGREE. A signboard case whose place has since been re-read to `match` sits in the board's
  // withdrawn section, which by design offers NO settle button: nobody has anything left to decide.
  // So the settlement the pillar honours is unreachable for exactly those cases, and reading the
  // integrity table alone charged three reps on production (2026-10-12) for findings their own
  // evidence had overturned — one of them 38 minutes after the compound-name fix shipped. Only the
  // source can pin this: the fixtures hand place cases straight to the pure function, which never
  // sees a place row.
  assert.ok(
    computeCode.includes("judgeLaterSignboardReading("),
    "the pillar must ask the board's own later-reading rule before charging a signboard place case",
  );
  assert.ok(
    computeCode.includes('.from("phoenix_crm_places")') && computeCode.includes('.select("id, signboard_check")'),
    "the withdrawal can only be seen by reading the flagged place's CURRENT signboard verdict",
  );
  assert.ok(
    /!later\.withdrawsFlag/.test(computeCode),
    "a case is dropped on withdrawsFlag — `match` alone, never !supportsFlag, which an unreadable re-read also satisfies",
  );
  assert.ok(
    !computeCode.includes("supportsFlag") && !/"match"/.test(computeCode),
    "compute must not re-implement the rule: the verdict names and their meaning live in location-integrity.ts",
  );
  assert.ok(
    computeCode.includes("readStoredSignboardVerdict("),
    "one coercion of signboard_check, shared with the board — a second hand-rolled one is how the two screens drift apart",
  );

  assert.ok(computeCode.includes("rankCountedFlags("), "the rank penalty goes through the one function that honours a settlement");
  assert.ok(
    !/\bcountedIntegrityFlags\(/.test(computeCode),
    "compute must not call countedIntegrityFlags directly — that path ignores the Super Admin's settlement",
  );

  // ── the portal never receives the metrics ─────────────────────────────────────────────────────
  const read = readFileSync(new URL("../src/lib/rep-ranks/server/read.ts", import.meta.url), "utf8");
  const portalColumns = /const PORTAL_COLUMNS =([\s\S]*?);\n/.exec(read)?.[1] ?? "";
  assert.ok(portalColumns.includes("pillars"), "the portal reads the scores");
  assert.ok(!portalColumns.includes("metrics"), "the portal query never selects the metrics column");
  assert.match(read, /input\.audience === "admin" \? ADMIN_COLUMNS : PORTAL_COLUMNS/);
  const profileQuery = /export async function loadRankProfile[\s\S]*?\.select\(([A-Z_]+)\)/.exec(read)?.[1];
  assert.equal(profileQuery, "PORTAL_COLUMNS", "a profile is scores only, whoever opens it");
}
