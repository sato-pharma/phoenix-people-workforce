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
  gateWindow,
  selectableWindows,
  windowLabel,
  windowPeriods,
} from "../src/lib/spotlight/period.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
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

  // ── 6. An untargeted subject is dropped from an achievement race, kept in a value one ──
  {
    const graded = { key: "a", title: "Graded", titleAr: null, roleLabel: "r", territory: "t", lineName: "CNS", hrId: null, isVacant: false, actualValue: 100, targetValue: 200, achievement: 50, varianceValue: -100, targetedMonths: 1, activeMonths: 1 };
    const others = { key: "b", title: "Others", titleAr: null, roleLabel: "r", territory: "t", lineName: "CNS", hrId: null, isVacant: false, actualValue: 834_365, targetValue: null, achievement: null, varianceValue: null, targetedMonths: 0, activeMonths: 1 };

    const byAchievement = rankRows([graded, others], "achievement", "top", null);
    assert.deepEqual(byAchievement.ranked.map((r) => r.key), ["a"], "no target means no place in an achievement ranking");
    assert.equal(byAchievement.untargeted, 1, "but the caller is told it was set aside");

    const byValue = rankRows([graded, others], "value", "top", null);
    assert.deepEqual(byValue.ranked.map((r) => r.key), ["b", "a"], "money is money, target or no target");
  }

  // ── 7. Ties break stably, so two exports of one selection agree ────────────
  {
    const mk = (key: string, title: string) => ({ key, title, titleAr: null, roleLabel: "r", territory: "t", lineName: "CNS", hrId: null, isVacant: false, actualValue: 500, targetValue: 500, achievement: 100, varianceValue: 0, targetedMonths: 1, activeMonths: 1 });
    const first = rankRows([mk("z", "Zakaria"), mk("a", "Ahmed")], "achievement", "top", null).ranked.map((r) => r.key);
    const again = rankRows([mk("a", "Ahmed"), mk("z", "Zakaria")], "achievement", "top", null).ranked.map((r) => r.key);
    assert.deepEqual(first, again, "input order cannot change the printed order");
    assert.deepEqual(first, ["a", "z"]);
  }

  // ── 8. Shortlist totals are summed, not averaged ───────────────────────────
  {
    const totals = summariseShortlist([
      { key: "a", title: "A", titleAr: null, roleLabel: "r", territory: "t", lineName: null, hrId: null, isVacant: false, actualValue: 200_000, targetValue: 100_000, achievement: 200, varianceValue: 100_000, targetedMonths: 1, activeMonths: 1 },
      { key: "b", title: "B", titleAr: null, roleLabel: "r", territory: "t", lineName: null, hrId: null, isVacant: false, actualValue: 450_000, targetValue: 900_000, achievement: 50, varianceValue: -450_000, targetedMonths: 1, activeMonths: 1 },
    ]);
    assert.equal(totals.targetValue, 1_000_000);
    assert.equal(totals.achievement, 65, "the pair's true joint achievement");
    assert.notEqual(totals.achievement, 125, "not the mean of 200 and 50");
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
    assert.equal(windowLabel({ kind: "semester", key: "2026-S2" }), "H2 2026");
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

  // ── 11. The picker can never offer what the export would refuse ────────────
  {
    const today = { year: 2026, month: 9 };
    for (const kind of ["month", "quarter", "semester"] as const) {
      const offered = selectableWindows(kind, today, 6);
      assert.ok(offered.length > 0, `${kind} picker offers something`);
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
}
