import assert from "node:assert/strict";

import {
  TRACKED_LINES,
  buildRows,
  hrKey,
  rankRows,
  summariseMonths,
  summariseShortlist,
  type OrgSeat,
  type SpotlightOrg,
} from "../src/lib/spotlight/rank.ts";
import {
  blockedReason,
  gateWindow,
  selectableWindows,
  windowLabel,
  windowPeriods,
} from "../src/lib/spotlight/period.ts";
import { buildSubheadline } from "../src/lib/spotlight/headline.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import type { SpotlightRow, SpotlightSelection } from "../src/lib/spotlight/types.ts";
import type { SpotlightSubjectKind } from "../src/lib/spotlight/types.ts";

// Spotlight — the arithmetic and the gate.
//
// The module hands the whole company a percentage with somebody's name on it, so the two ways that
// number can be quietly wrong are pinned here rather than trusted:
//
//   1. AVERAGING PERCENTAGES instead of summing first. Not an approximation — a different number.
//   2. DIVIDING BY THE WRONG MONTHS. The closing counts only months that carry a target, on BOTH
//      sides of the fraction. Ignoring that reads 77.55% where the closing reads 35.26%.
//
// Plus the two ways it can name the wrong person: a vacant seat picking up a name, and an HR id
// compared case-sensitively.

// ── Fixtures ────────────────────────────────────────────────────────────────

function row(overrides: Partial<AchievementRow> & { period: string }): AchievementRow {
  return {
    lineCode: "cns",
    regionCode: "GZ",
    areaCode: "GZ5",
    areaState: null,
    isOther: false,
    repSeatId: "SEAT-CNS-REP-GZ5",
    repHrId: "B-136",
    dmSeatId: "SEAT-CNS-DM-GZ",
    dmHrId: "B-117",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
    ...overrides,
  };
}

function seat(overrides: Partial<OrgSeat> & { seatId: string; tier: string }): OrgSeat {
  return {
    parentSeatId: null,
    lineCode: "cns",
    lineName: "CNS",
    regionCode: "GZ",
    regionName: "Giza",
    areaCode: null,
    areaName: null,
    occupantHrId: null,
    isVacant: true,
    displayLabel: overrides.seatId,
    ...overrides,
  };
}

function org(): SpotlightOrg {
  const seats = new Map<string, OrgSeat>();
  seats.set("SEAT-CNS-NSM", seat({ seatId: "SEAT-CNS-NSM", tier: "NSM", regionCode: null, regionName: null, occupantHrId: "B-122", isVacant: false }));
  seats.set("SEAT-CNS-DM-GZ", seat({ seatId: "SEAT-CNS-DM-GZ", tier: "DM", parentSeatId: "SEAT-CNS-NSM", occupantHrId: "B-117", isVacant: false }));
  seats.set("SEAT-CNS-REP-GZ5", seat({ seatId: "SEAT-CNS-REP-GZ5", tier: "REP", parentSeatId: "SEAT-CNS-DM-GZ", areaCode: "GZ5", areaName: "Helwan-Maadi", occupantHrId: "B-136", isVacant: false }));
  seats.set("SEAT-CNS-REP-GZ1", seat({ seatId: "SEAT-CNS-REP-GZ1", tier: "REP", parentSeatId: "SEAT-CNS-DM-GZ", areaCode: "GZ1", areaName: "Giza - Giza Centers" }));

  const people = new Map([
    ["b-136", { hrId: "B-136", fullName: "Fatma Gharib Mohamed Ibrahim", nameAr: "فاطمة غريب محمد ابراهيم", jobTitle: "Medical Representative" }],
    ["b-117", { hrId: "B-117", fullName: "Sameh Shabaan El Hoseiny El Hoseiny", nameAr: null, jobTitle: "District Sales Manager" }],
    ["b-122", { hrId: "B-122", fullName: "Amr Mohamed Naguib Elsebaey", nameAr: null, jobTitle: "National Sales Manager" }],
  ]);

  return { seats, people };
}

const NAMES = {
  lineNames: new Map([["cns", "CNS"], ["pedia", "Pedia"], ["anti_infective", "Anti Infective"]]),
  regionNames: new Map([["GZ", "Giza"], ["CA", "Cairo"]]),
  areaNames: new Map([["GZ5", "Helwan-Maadi"], ["GZ1", "Giza - Giza Centers"]]),
};

function build(rows: AchievementRow[], kind: SpotlightSubjectKind, filters = {}) {
  return buildRows(rows, { kind, org: org(), filters, ...NAMES });
}

export function runSpotlightRankingTests() {
  // ── 1. A percentage is computed from the sums, never averaged ──────────────
  //
  // 200% of a 100k target and 50% of a 900k target. The mean is 125%; the truth is 65%.
  {
    const months = new Map([
      ["2026-07", { actual: 200_000, target: 100_000 }],
      ["2026-08", { actual: 450_000, target: 900_000 }],
    ]);
    const summary = summariseMonths(months);
    assert.equal(summary.target, 1_000_000);
    assert.equal(summary.achievement, 65, "achievement is the sum of actuals over the sum of targets");
    assert.notEqual(summary.achievement, 125, "and is emphatically NOT the mean of the monthly percentages");
  }

  // ── 2. Across months, only the months carrying a target count — both sides ──
  {
    const months = new Map([
      ["2026-06", { actual: 500_000, target: 0 }],   // real sales, no target set
      ["2026-07", { actual: 100_000, target: 200_000 }],
    ]);
    const summary = summariseMonths(months);
    assert.equal(summary.target, 200_000, "the untargeted month adds nothing to the denominator");
    assert.equal(summary.achievement, 50, "nor to the numerator");
    assert.equal(summary.targetedMonths, 1);
    assert.equal(summary.activeMonths, 2, "but it did happen, and is still counted as an active month");

    // WHICH month, not just how many. A renderer holding only the count cannot name the denominator,
    // and the hero sheet names it in words on a page handed to the person it is about.
    assert.deepEqual(summary.targetedPeriods, ["2026-07"], "the targeted month is named, so a sheet can say so");
    assert.equal(summary.graded, 100_000, "the numerator is carried, not left to be reconstructed");

    // The naive reading — every pound over the targeted months' targets — is the 300% this rule exists
    // to stop. Assert the wrong answer is NOT produced, so a future refactor cannot quietly restore it.
    assert.notEqual(summary.achievement, 300);

    // And every pound IS still reported, separately, under its own name.
    assert.equal(summary.actual, 600_000, "actualValue is all the money, graded or not");
  }

  // ── 3. Vacant seats are never given a name ─────────────────────────────────
  {
    const rows = build([row({ period: "2026-08", repSeatId: "SEAT-CNS-REP-GZ1", repHrId: null, areaCode: "GZ1", actualValue: 165_997, targetValue: 270_874, hasTarget: true })], "rep");
    assert.equal(rows.length, 1, "a vacant seat that sold is still a subject — its money is real");
    assert.equal(rows[0]!.isVacant, true);
    assert.equal(rows[0]!.hrId, null);
    assert.ok(rows[0]!.title.includes("Giza - Giza Centers"), "it prints its territory");
    assert.ok(!rows[0]!.title.includes("Fatma"), "and never borrows a neighbour's name");
  }

  // ── 3b. Vacant seats can be excluded, and are KEPT by default ──────────────
  //
  // Reported live on the first top-ten ever exported: Port Said and Domiat took 8th place at
  // 130.7% with nobody in the seat. Both readings are legitimate — a recognition sheet wants
  // people, a performance read must not lose real money — so it is a switch, and its ABSENCE
  // means no restriction rather than a silent exclusion.
  {
    const rows = [
      row({ period: "2026-08", actualValue: 500, targetValue: 400, hasTarget: true }),
      row({ period: "2026-08", repSeatId: "SEAT-CNS-REP-GZ1", repHrId: null, areaCode: "GZ1", actualValue: 900, targetValue: 400, hasTarget: true }),
    ];

    const kept = build(rows, "rep");
    assert.equal(kept.length, 2, "by default a vacant seat keeps its place — its money is real");
    assert.equal(kept.filter((r) => r.isVacant).length, 1);

    const peopleOnly = build(rows, "rep", { excludeVacant: true });
    assert.equal(peopleOnly.length, 1, "excludeVacant drops the empty seat");
    assert.equal(peopleOnly[0]!.isVacant, false);
    assert.equal(peopleOnly[0]!.title, "Fatma Gharib Mohamed Ibrahim");

    // 🔴 AND IT MUST NOT FIRE ON A SEATED PERSON. The vacant seat here is the HIGHER achiever, so
    // a filter with the condition inverted would silently keep it and drop the real rep — which
    // looks like a working filter until you read the name.
    assert.ok(!peopleOnly.some((r) => r.title.includes("vacant")), "and never the other way round");
  }

  // ── 4. HR ids are compared case-insensitively ──────────────────────────────
  {
    assert.equal(hrKey("B-136"), hrKey("b-136"));
    const rows = build(
      [row({ period: "2026-08", actualValue: 849_126, targetValue: 444_641, hasTarget: true })],
      "rep",
      { hrIds: ["b-136"] },
    );
    assert.equal(rows.length, 1, "a lower-cased filter still finds an upper-cased HR id");
    assert.equal(rows[0]!.title, "Fatma Gharib Mohamed Ibrahim");
    assert.equal(rows[0]!.titleAr, "فاطمة غريب محمد ابراهيم");
  }

  // ── 5. Head Office never enters an unfiltered spotlight ────────────────────
  {
    assert.deepEqual([...TRACKED_LINES], ["cns", "pedia", "anti_infective"]);
    const rows = build([
      row({ period: "2026-08", actualValue: 100, targetValue: 100, hasTarget: true }),
      row({ period: "2026-08", lineCode: "head_office", repSeatId: "SEAT-HO", actualValue: 99_000_000 }),
    ], "rep");
    assert.equal(rows.length, 1, "the Head Office row is filtered out before it can be aggregated");
    assert.equal(rows[0]!.actualValue, 100);
  }

  // ── 5b. The targeted months come back in calendar order, not query order ───
  {
    // Rows arrive in whatever order the query returned them, and a Map preserves INSERTION order —
    // so a sheet naming these months would print "August · June" for a window targeted in both.
    const months = new Map([
      ["2026-08", { actual: 300, target: 300 }],
      ["2026-06", { actual: 100, target: 100 }],
    ]);
    assert.deepEqual(
      summariseMonths(months).targetedPeriods,
      ["2026-06", "2026-08"],
      "sorted here rather than trusted — the caller writes these into a sentence",
    );
  }

  // ── 6. An untargeted subject is dropped from an achievement race, kept in a value one ──
  {
    const graded = { key: "a", title: "Graded", titleAr: null, roleLabel: "r", territory: "t", lineName: "CNS", hrId: null, isVacant: false, actualValue: 100, gradedValue: 100, targetValue: 200, achievement: 50, varianceValue: -100, targetedPeriods: ["2026-07"], targetedMonths: 1, activeMonths: 1 };
    // "Others" carries real money and was targeted in no month at all, so its graded figure is zero
    // while its actual is 834,365 — the exact shape the sheet must not print as one number.
    const others = { key: "b", title: "Others", titleAr: null, roleLabel: "r", territory: "t", lineName: "CNS", hrId: null, isVacant: false, actualValue: 834_365, gradedValue: 0, targetValue: null, achievement: null, varianceValue: null, targetedPeriods: [], targetedMonths: 0, activeMonths: 1 };

    const byAchievement = rankRows([graded, others], "achievement", "top", null);
    assert.deepEqual(byAchievement.ranked.map((r) => r.key), ["a"], "no target means no place in an achievement ranking");
    assert.equal(byAchievement.untargeted, 1, "but the caller is told it was set aside");

    const byValue = rankRows([graded, others], "value", "top", null);
    assert.deepEqual(byValue.ranked.map((r) => r.key), ["b", "a"], "money is money, target or no target");
  }

  // ── 7. Ties break stably, so two exports of one selection agree ────────────
  {
    const mk = (key: string, title: string) => ({ key, title, titleAr: null, roleLabel: "r", territory: "t", lineName: "CNS", hrId: null, isVacant: false, actualValue: 500, gradedValue: 500, targetValue: 500, achievement: 100, varianceValue: 0, targetedPeriods: ["2026-08"], targetedMonths: 1, activeMonths: 1 });
    const first = rankRows([mk("z", "Zakaria"), mk("a", "Ahmed")], "achievement", "top", null).ranked.map((r) => r.key);
    const again = rankRows([mk("a", "Ahmed"), mk("z", "Zakaria")], "achievement", "top", null).ranked.map((r) => r.key);
    assert.deepEqual(first, again, "input order cannot change the printed order");
    assert.deepEqual(first, ["a", "z"]);
  }

  // ── 8. Shortlist totals are summed, not averaged ───────────────────────────
  {
    const totals = summariseShortlist([
      { key: "a", title: "A", titleAr: null, roleLabel: "r", territory: "t", lineName: null, hrId: null, isVacant: false, actualValue: 200_000, gradedValue: 200_000, targetValue: 100_000, achievement: 200, varianceValue: 100_000, targetedPeriods: ["2026-07"], targetedMonths: 1, activeMonths: 1 },
      { key: "b", title: "B", titleAr: null, roleLabel: "r", territory: "t", lineName: null, hrId: null, isVacant: false, actualValue: 450_000, gradedValue: 450_000, targetValue: 900_000, achievement: 50, varianceValue: -450_000, targetedPeriods: ["2026-08"], targetedMonths: 1, activeMonths: 1 },
    ]);
    assert.equal(totals.targetValue, 1_000_000);
    assert.equal(totals.achievement, 65, "the pair's true joint achievement");
    assert.notEqual(totals.achievement, 125, "not the mean of 200 and 50");
  }

  // ── 8b. A shortlist total reads the numerator off the row, untargeted money excluded ──
  {
    // One subject, targeted in one month of two, with half its money earned in the untargeted month.
    // A total built from `actualValue` reads 150% here; the rule says 100%.
    const totals = summariseShortlist([
      { key: "a", title: "A", titleAr: null, roleLabel: "r", territory: "t", lineName: null, hrId: null, isVacant: false, actualValue: 300_000, gradedValue: 200_000, targetValue: 200_000, achievement: 100, varianceValue: 0, targetedPeriods: ["2026-07"], targetedMonths: 1, activeMonths: 2 },
    ]);
    assert.equal(totals.actualValue, 300_000, "every pound is still reported");
    assert.equal(totals.achievement, 100, "but the percentage is graded money over target");
    assert.notEqual(totals.achievement, 150, "which is what reading actualValue here would have printed");
  }

  // ── 9. A district ranking climbs from rep rows, so vacant districts still total ──
  {
    const rows = build([
      row({ period: "2026-08", actualValue: 600_000, targetValue: 400_000, hasTarget: true }),
      row({ period: "2026-08", repSeatId: "SEAT-CNS-REP-GZ1", repHrId: null, areaCode: "GZ1", actualValue: 165_997, targetValue: 270_874, hasTarget: true }),
    ], "dm");
    assert.equal(rows.length, 1, "both rep rows fold into the one district seat above them");
    assert.equal(rows[0]!.actualValue, 765_997);
    assert.equal(rows[0]!.targetValue, 670_874);
    assert.equal(rows[0]!.title, "Sameh Shabaan El Hoseiny El Hoseiny");
  }

  // ── 10. The window gate ────────────────────────────────────────────────────
  {
    assert.deepEqual(windowPeriods({ kind: "month", key: "2026-08" }), ["2026-08"]);
    assert.deepEqual(windowPeriods({ kind: "quarter", key: "2026-Q3" }), ["2026-07", "2026-08", "2026-09"]);
    assert.deepEqual(windowPeriods({ kind: "semester", key: "2026-S2" }), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
    assert.equal(windowLabel({ kind: "quarter", key: "2026-Q3" }), "Q3 2026");
    // "Semester 2 2026", never "H2 2026" — owner rule, 2026-09-23 ("call it semester 1 and 2 and
    // s1 and s2 not h1 and h2"). The KEY keeps its `2026-S2` form; only the words changed.
    assert.equal(windowLabel({ kind: "semester", key: "2026-S2" }), "Semester 2 2026");
    assert.equal(windowLabel({ kind: "month", key: "2026-08" }), "August 2026");

    // August, judged from inside September: allowed.
    const august = gateWindow({ kind: "month", key: "2026-08" }, { year: 2026, month: 9 });
    assert.equal(august.allowed, true);

    // September, judged from inside September: refused, and the refusal names the date.
    const september = gateWindow({ kind: "month", key: "2026-09" }, { year: 2026, month: 9 });
    assert.equal(september.allowed, false);
    assert.ok(september.allowed === false && september.reason.includes("1 October 2026"),
      "a refusal that does not say when it lifts reads as a bug");

    // Q3 is not available in September even though two of its months have finished. REFUSED, never
    // silently shortened — "Q3 2026" printed over two months is the failure this gate exists for.
    const q3 = gateWindow({ kind: "quarter", key: "2026-Q3" }, { year: 2026, month: 9 });
    assert.equal(q3.allowed, false);
    const q2 = gateWindow({ kind: "quarter", key: "2026-Q2" }, { year: 2026, month: 9 });
    assert.equal(q2.allowed, true);

    // December rolls the year, rather than asking for month 13.
    const dec = gateWindow({ kind: "month", key: "2026-12" }, { year: 2027, month: 1 });
    assert.equal(dec.allowed, true);
  }

  // ── 10b. The YEAR window ───────────────────────────────────────────────────
  {
    assert.deepEqual(windowPeriods({ kind: "year", key: "2026" }), [
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
    assert.equal(windowLabel({ kind: "year", key: "2026" }), "2026");

    // Refused mid-year, and the refusal names the day it lifts — NOT silently shortened to the
    // months that have finished, which would print "2026" over eight of them.
    const running = gateWindow({ kind: "year", key: "2026" }, { year: 2026, month: 9 });
    assert.equal(running.allowed, false);
    assert.ok(running.allowed === false && running.reason.includes("1 January 2027"));

    // Allowed the moment it closes.
    assert.equal(gateWindow({ kind: "year", key: "2026" }, { year: 2027, month: 1 }).allowed, true);

    // 2025 is refused for a DIFFERENT reason — the engine holds nothing before 2026-01 — and the
    // message says so rather than claiming the year has not finished.
    const early = gateWindow({ kind: "year", key: "2025" }, { year: 2027, month: 1 });
    assert.equal(early.allowed, false);
    assert.ok(early.allowed === false && early.reason.includes("2026-01"),
      "a year below the data floor is refused on the floor, not on completeness");

    // 🔴 THE CONSEQUENCE, PINNED. Through 2026 the year picker is legitimately EMPTY: 2026 has not
    // finished and 2025 is below the data floor. That is the gate working, not a broken picker,
    // and the UI says so in those words. From January 2027 it offers exactly 2026.
    assert.deepEqual(selectableWindows("year", { year: 2026, month: 9 }, 4), [],
      "no calendar year is selectable while 2026 is still running");
    assert.deepEqual(
      selectableWindows("year", { year: 2027, month: 1 }, 4).map((w) => w.key),
      ["2026"],
      "the first selectable year is 2026, from January 2027",
    );
  }

  // ── 11. The picker can never offer what the export would refuse ────────────
  {
    const today = { year: 2026, month: 9 };
    for (const kind of ["month", "quarter", "semester", "year"] as const) {
      const offered = selectableWindows(kind, today, 6);
      // Year is legitimately empty until 2027, so only the others must be non-empty.
      if (kind !== "year") assert.ok(offered.length > 0, `${kind} picker offers something`);
      for (const window of offered) {
        assert.equal(gateWindow(window, today).allowed, true,
          `${kind} picker offered ${window.key}, which the gate refuses`);
      }
      const keys = offered.map((window) => window.key);
      assert.equal(new Set(keys).size, keys.length, `${kind} picker offers no duplicates`);
    }
    assert.equal(selectableWindows("month", today, 3)[0]!.key, "2026-08", "newest complete month first");
    assert.equal(selectableWindows("quarter", today, 3)[0]!.key, "2026-Q2");
  }

  // ── 12. A disabled control ALWAYS carries its reason ───────────────────────
  //
  // Reported live: "the show me button does nothing". It was disabled, correctly, because Year has
  // no selectable period until 2027 — and it said nothing, so a working guard was indistinguishable
  // from a broken page. The reason and the disabling now come from ONE value, so they cannot drift.
  {
    assert.equal(blockedReason("month", true), null, "a selectable period blocks nothing");
    assert.equal(blockedReason("year", true), null);

    const year = blockedReason("year", false);
    assert.ok(year, "an empty year picker MUST explain itself");
    assert.ok(year!.includes("1 January 2027"), "and name the date it becomes available");
    assert.ok(year!.includes("Month, Quarter or Half year"), "and say what to do instead");

    const month = blockedReason("month", false);
    assert.ok(month && month.includes("month"), "every kind gets a reason, not just year");
    assert.ok(blockedReason("semester", false)!.includes("half year"),
      "and it reads as English — 'half year', never the internal word 'semester'");

    // Every window kind must produce a reason. A kind added later with no wording would fall back
    // to a silent disable, which is exactly the defect this test exists to prevent.
    for (const kind of ["month", "quarter", "semester", "year"] as const) {
      assert.ok(blockedReason(kind, false), `${kind} explains why it is blocked`);
    }
  }

  // ── 13. The sub-line never claims a scope the sheet does not have ───────────────────
  //
  // The exported August 2026 sheet printed "August 2026 · All lines · Ranked by achievement" over a
  // ranking Head Office is deliberately absent from. Head Office is 90% of weekly value, so "all
  // lines" was not a rounding of the truth — it was the opposite of it, printed on a document that
  // goes in front of the whole company. Owner's wording, 12 September 2026: "All tracked lines".
  {
    const selection = (lines: string[] | undefined): SpotlightSelection => ({
      window: { kind: "month", key: "2026-08" },
      subject: "rep",
      filters: { lines },
      rankBy: "achievement",
      direction: "top",
      limit: 10,
      layout: "both",
    });

    const subject = (title: string, lineName: string | null): SpotlightRow => ({
      key: title,
      title,
      titleAr: null,
      roleLabel: "Medical Representative",
      territory: "Dakahlia 1",
      lineName,
      hrId: null,
      isVacant: false,
      actualValue: 100,
      gradedValue: 100,
      targetValue: 50,
      achievement: 200,
      varianceValue: 50,
      targetedPeriods: ["2026-08"],
      targetedMonths: 1,
      activeMonths: 1,
    });

    const names = new Map([["cns", "CNS"], ["pedia", "Pedia"], ["anti_infective", "Anti Infective"]]);
    const sub = (lines: string[] | undefined, rows: SpotlightRow[]) => buildSubheadline({
      selection: selection(lines),
      rows,
      windowLabel: "August 2026",
      lineNames: names,
      regionNames: new Map(),
      areaNames: new Map(),
    });

    const spread = [subject("Batool", "CNS"), subject("Mostafa", "Pedia")];
    const whole = sub(["cns", "pedia", "anti_infective"], spread);
    assert.ok(whole.includes("All tracked lines"),
      "the widest scope the sheet has is the three TRACKED lines, and the sub-line says so");
    assert.ok(!whole.includes("All lines"),
      "and never the bare claim \"All lines\" — Head Office is 90% of weekly value and is not in this ranking");

    // 🔴 AND WHO WON IS NOT EVIDENCE OF THE SCOPE. Nine of the real August 2026 top ten were
    // CNS; one Pedia rep at number six was all that stood between the sheet and announcing a
    // three-line ranking as a CNS one.
    const swept = [subject("Batool", "CNS"), subject("Fatma", "CNS")];
    const allCns = sub(["cns", "pedia", "anti_infective"], swept);
    assert.ok(allCns.includes("All tracked lines"),
      "one line sweeping the top ten does not turn a three-line ranking into a sheet of its own");
    assert.ok(!allCns.includes("CNS"),
      "and the line name is printed only where it was FILTERED to, never appended from who happened to win");

    // The narrower shapes are untouched: naming the lines you picked beats any summary of them.
    assert.ok(sub(["cns"], spread).includes("CNS"), "one line picked is still named outright");
    assert.ok(!sub(["cns"], spread).includes("tracked"),
      "and a single-line sheet never calls itself tracked-wide");
    assert.ok(sub(["cns", "pedia"], spread).includes("CNS and Pedia"),
      "two lines picked are both named, joined with 'and' and no ellipsis");

    // An override still wins outright — the owner's own words are never second-guessed.
    const overridden = buildSubheadline({
      selection: { ...selection(undefined), subheadline: "CNS only, by request" },
      rows: spread,
      windowLabel: "August 2026",
      lineNames: names,
      regionNames: new Map(),
      areaNames: new Map(),
    });
    assert.equal(overridden, "CNS only, by request", "a typed sub-line is printed exactly as typed");
  }
}
