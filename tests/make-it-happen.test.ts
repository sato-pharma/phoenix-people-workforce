import assert from "node:assert/strict";

import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { HONESTY_SENTENCE, isFaithfulRewrite, templateCoachMessage } from "@/lib/sales/make-it-happen/coach";
import {
  achievementOf,
  buildRealisticMix,
  gradeRows,
  offeredPeriods,
  parseForecastUnits,
  periodKeyOf,
  periodLabel,
  periodMonths,
  readTrend,
} from "@/lib/sales/make-it-happen/engine";
import {
  applyMakeItHappenBound,
  canUseMakeItHappen,
  isTeamBound,
  makeItHappenBoundLabel,
} from "@/lib/sales/make-it-happen/scope";

function row(overrides: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-07",
    lineCode: "cns",
    regionCode: "R1",
    areaCode: "A1",
    areaState: "occupied",
    isOther: false,
    repSeatId: null,
    repHrId: "M-1",
    dmSeatId: null,
    dmHrId: "D-1",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: false,
    ...overrides,
  } as AchievementRow;
}

export async function runMakeItHappenTests() {
  // ── Periods ──
  assert.deepEqual(periodMonths("quarter", "2026-Q3"), ["2026-07", "2026-08", "2026-09"]);
  assert.deepEqual(periodMonths("semester", "2026-H2"), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
  assert.equal(periodMonths("quarter", "2026-Q5"), null, "a malformed quarter is refused");
  assert.equal(periodKeyOf("quarter", "2026-11"), "2026-Q4");
  assert.equal(periodKeyOf("semester", "2026-03"), "2026-H1");
  assert.equal(periodLabel("quarter", "2026-Q3"), "Q3 2026 · July to September");
  assert.deepEqual(
    offeredPeriods("month", "2026-09").map((option) => option.value),
    ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"],
    "months start at July 2026 — January to June are never offered",
  );
  assert.deepEqual(offeredPeriods("quarter", "2026-09").map((option) => option.value), ["2026-Q3", "2026-Q4"]);
  assert.deepEqual(offeredPeriods("semester", "2026-09").map((option) => option.value), ["2026-H2"], "the first half is before the floor");

  // ── Typed units ──
  assert.equal(parseForecastUnits(""), 0);
  assert.equal(parseForecastUnits(" 40 "), 40);
  assert.equal(parseForecastUnits("4.5"), null, "half a box is refused, never rounded");
  assert.equal(parseForecastUnits("-3"), null);
  assert.equal(parseForecastUnits("abc"), null);
  assert.equal(parseForecastUnits("99999999999"), null);

  // ── Grading: the Sales vs Target rule ──
  const graded = gradeRows([
    { period: "2026-07", closed: true, actualUnits: 5, actualValue: 50, targetUnits: 10, targetValue: 100 },
    { period: "2026-07", closed: true, actualUnits: 3, actualValue: 30, targetUnits: null, targetValue: null },
    { period: "2026-08", closed: true, actualUnits: 4, actualValue: 40, targetUnits: null, targetValue: null },
    { period: "2026-09", closed: false, actualUnits: 99, actualValue: 999, targetUnits: 20, targetValue: 200 },
  ]);
  assert.equal(graded.targetValue, 300, "targets count in every month, closed or not");
  assert.equal(graded.actualValue, 120, "an unclosed month's actuals never count");
  assert.equal(graded.gradedValue, 80, "a month the set carries no target in is sold but not graded");
  assert.equal(achievementOf(80, 0, null), null, "no target reads null, never 0%");
  assert.equal(achievementOf(80, 20, 200), 0.5);

  // ── The realistic pace ──
  assert.deepEqual(readTrend([], 2), { kind: "none", historyMonths: 0, spikesIgnored: 0, expectedUnits: 0, realisticMaxUnits: 0 });
  assert.equal(readTrend([0, 0, 0], 2).kind, "none");

  const early = readTrend([90, 110], 2);
  assert.equal(early.kind, "early");
  assert.equal(early.expectedUnits, 200, "fewer than three closed months: the average of the closed months");
  assert.equal(early.realisticMaxUnits, 200, "and never above that average (owner choice)");

  const flat = readTrend([100, 102, 98, 101], 2);
  assert.equal(flat.kind, "flat");
  assert.equal(flat.expectedUnits, 200);
  assert.equal(flat.realisticMaxUnits, 200, "a plateau stays a plateau");

  const growing = readTrend([100, 120, 140, 160], 3);
  assert.equal(growing.kind, "growing");
  assert.equal(growing.expectedUnits, 420);
  assert.equal(growing.realisticMaxUnits, 480, "growth may continue, but never above the best normal month");

  const declining = readTrend([200, 180, 160, 140], 2);
  assert.equal(declining.kind, "declining");
  assert.equal(declining.realisticMaxUnits, 280, "a decline is held at its recent level, never inflated");
  assert.equal(declining.expectedUnits, declining.realisticMaxUnits);

  const spike = readTrend([100, 100, 1000, 100], 1);
  assert.equal(spike.spikesIgnored, 1, "a one-off bulk month is not a pace");
  assert.equal(spike.realisticMaxUnits, 100);

  // ── The mix ──
  const items = [
    { key: "A", price: 10, expectedUnits: 10, realisticMaxUnits: 20, unitsStillToTarget: null },
    { key: "B", price: 100, expectedUnits: 1, realisticMaxUnits: 5, unitsStillToTarget: 3 },
  ];
  const reachable = buildRealisticMix(items, 250);
  assert.equal(reachable.reachable, true);
  assert.deepEqual(reachable.units, { A: 10, B: 2 }, "a product still short of its own target is raised first, and only as far as needed");

  const short = buildRealisticMix(items, 1000);
  assert.equal(short.reachable, false, "an out-of-reach target is reported as out of reach");
  assert.deepEqual(short.units, { A: 20, B: 5 }, "never above any product's realistic max");
  assert.equal(short.shortValue, 300);

  const noTarget = buildRealisticMix(items, null);
  assert.equal(noTarget.reachable, null);
  assert.deepEqual(noTarget.units, { A: 10, B: 1 });

  // ── Honest wording, and nothing says AI ──
  const base = { periodLabel: "Q3 2026", earlyHistory: false, onTrack: false, picks: [{ name: "Tebofortine", unitsLabel: "20" }] };
  const messages = [
    templateCoachMessage({ ...base, projectedAchievementLabel: "82.0%", shortValueLabel: "EGP 300", reachable: false }),
    templateCoachMessage({ ...base, projectedAchievementLabel: "100.0%", shortValueLabel: null, reachable: true }),
    templateCoachMessage({ ...base, projectedAchievementLabel: "104.0%", shortValueLabel: null, reachable: true, onTrack: true }),
    templateCoachMessage({ ...base, projectedAchievementLabel: null, shortValueLabel: null, reachable: null }),
  ];
  assert.match(messages[0], /Phoenix is here to support you, not to show you dream numbers/);
  assert.match(messages[1], /Phoenix will make it happen/);
  for (const message of messages) assert.doesNotMatch(message, /\bAI\b|artificial|model/i);

  // ── A rewrite is shown only when it says what the template says ──
  const outOfReach = {
    periodLabel: "Q3 2026 · July to September",
    projectedAchievementLabel: "24.0%",
    shortValueLabel: "EGP 96,264",
    reachable: false,
    onTrack: false,
    earlyHistory: true,
    picks: [
      { name: "Saginko", unitsLabel: "81" },
      { name: "Royafloxacin", unitsLabel: "18" },
    ],
  };
  const outOfReachTemplate = templateCoachMessage(outOfReach);
  assert.equal(isFaithfulRewrite(outOfReach, outOfReachTemplate, outOfReachTemplate), true, "the template is faithful to itself");
  assert.equal(
    isFaithfulRewrite(
      outOfReach,
      outOfReachTemplate,
      "Realistically, for Q3 2026 (July to September) you are at 24.0% of target, which means you are EGP 96,264 short, so I am not going to talk about dream numbers. Focus on 81 units of Saginko and 18 units of Royafloxacin.",
    ),
    false,
    "a rewrite measured on 2026-09-14 — honesty sentence dropped, 'you are at', first person — is refused",
  );
  assert.equal(
    isFaithfulRewrite(
      outOfReach,
      outOfReachTemplate,
      `Your best for Q3 2026 · July to September is 24.0% of target, EGP 96,264 short. ${HONESTY_SENTENCE}. Put your energy into 81 units of Saginko and 18 units of Royafloxacin.`,
    ),
    true,
    "a warmer rewrite that keeps every figure, name and the honesty sentence is kept",
  );
  assert.equal(
    isFaithfulRewrite(
      outOfReach,
      outOfReachTemplate,
      `Your best for Q3 2026 · July to September is 24.0% of target, EGP 96,264 short, maybe 30% with effort. ${HONESTY_SENTENCE}. Focus on 81 units of Saginko and 18 units of Royafloxacin.`,
    ),
    false,
    "a rewrite that adds a number is refused",
  );
  assert.equal(
    isFaithfulRewrite(
      outOfReach,
      outOfReachTemplate,
      `Realistically, for Q3 2026, July to September is 24.0% of target, EGP 96,264 short, so focus on 81 units of Saginko and 18 units of Royafloxacin. ${HONESTY_SENTENCE}, and with only a few closed months, Phoenix will keep each product at its average so far.`,
    ),
    false,
    "a rewrite measured on 2026-09-14 that kept every figure but lost 'your best' — so the percentage no longer says what it means — is refused",
  );

  // ── Scope ──
  for (const role of ["Medical Rep", "District Manager", "National Sales Manager", "SFE Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Super Admin"]) {
    assert.equal(canUseMakeItHappen(role), true, `${role} is one of the eight owner-named roles`);
  }
  for (const role of ["CEO", "Regional Manager", "Employee", "HR Operations", null]) {
    assert.equal(canUseMakeItHappen(role), false, `${role ?? "no role"} was not named`);
  }

  const rows = [
    row({ productCode: "p1" }),
    row({ productCode: "P2", lineCode: "pedia" }),
    row({ productCode: "P3", repHrId: "M-2" }),
  ];
  const pmScoped = applyMakeItHappenBound(rows, { rows: { kind: "company" }, productCodes: new Set(["P1", "P3"]), label: "Your products" });
  assert.deepEqual(pmScoped.map((item) => item.productCode), ["p1", "P3"], "a Product Manager plans their own products company-wide");
  const selfScoped = applyMakeItHappenBound(rows, { rows: { kind: "self", hrId: "M-1" } as never, productCodes: null, label: "You" });
  assert.ok(selfScoped.every((item) => item.repHrId === "M-1"), "a medical rep never plans another rep's rows");
  assert.equal(isTeamBound({ rows: { kind: "self", hrId: "M-1" } as never, productCodes: null, label: "" }), false);
  assert.equal(isTeamBound({ rows: { kind: "company" }, productCodes: null, label: "" }), true);
  assert.equal(makeItHappenBoundLabel({ kind: "line", lineCodes: new Set(["PD"]) }), "Your line");
  assert.equal(
    makeItHappenBoundLabel({ kind: "line", lineCodes: new Set(["AI", "CNS", "PD"]) }),
    "Your lines",
    "a viewer on three lines is never told it is one line",
  );
}
