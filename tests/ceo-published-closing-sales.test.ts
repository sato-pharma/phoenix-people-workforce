import assert from "node:assert/strict";
import {
  aggregatePublishedClosingSales,
  companyPublishedPeriods,
  type PublishedClosingSales,
} from "../src/lib/ceo/published-closing-sales.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

// Compile-time half of "no units on the overview": CI's typecheck refuses this file if any unit or
// quantity field is ever added to the result type. The runtime walk below is the half this runner sees.
type KeysDeep<T> = T extends Array<infer U> ? KeysDeep<U> : T extends object ? { [K in keyof T]: K | KeysDeep<T[K]> }[keyof T] : never;
type UnitLikeKey = Extract<KeysDeep<PublishedClosingSales>, `${string}${"unit" | "Unit" | "qty" | "Qty" | "quantity" | "Quantity"}${string}`>;
const noUnitKeyOnTheType: [UnitLikeKey] extends [never] ? true : false = true;

function row(partial: Partial<AchievementRow> & Pick<AchievementRow, "period" | "lineCode" | "actualValue">): AchievementRow {
  return {
    regionCode: "CA",
    areaCode: "CA1",
    areaState: null,
    isOther: false,
    repSeatId: null,
    repHrId: null,
    dmSeatId: null,
    dmHrId: null,
    productCode: "P001",
    actualUnits: 10,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
    ...partial,
  };
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      keysDeep(inner, out);
    }
  }
  return out;
}

const NOW = new Date("2026-11-27T10:00:00Z");
const keysFor = (lines: string[], periods: string[]) => new Set(lines.flatMap((line) => periods.map((period) => `${line}|${period}`)));

export function runCeoPublishedClosingSalesTests() {
  assert.equal(noUnitKeyOnTheType, true);

  // Published: Jul–Oct on all three lines; November on CNS only (and it is the running month);
  // Head Office keyed too, as a hostile publication row would be.
  const publishedKeys = new Set([
    ...keysFor(["cns", "pedia", "anti_infective"], ["2026-07", "2026-08", "2026-09", "2026-10"]),
    "cns|2026-11",
    "head_office|2026-10",
  ]);
  // September is published on two lines only — it must vanish whole.
  publishedKeys.delete("pedia|2026-09");

  const rows: AchievementRow[] = [
    // July: sales, NO target anywhere → never graded.
    row({ period: "2026-07", lineCode: "cns", actualValue: 500 }),
    // August: targeted.
    row({ period: "2026-08", lineCode: "cns", actualValue: 800, targetValue: 1000, hasTarget: true }),
    row({ period: "2026-08", lineCode: "pedia", actualValue: 300, targetValue: 600, hasTarget: true }),
    // September: partly published (Pedia missing) — excluded from everything.
    row({ period: "2026-09", lineCode: "cns", actualValue: 9_999, targetValue: 1000, hasTarget: true }),
    // October: the headline.
    row({ period: "2026-10", lineCode: "cns", regionCode: "D1", actualValue: 600, targetValue: 1000, hasTarget: true }),
    row({ period: "2026-10", lineCode: "cns", regionCode: "UE", actualValue: 400.004 }),
    row({ period: "2026-10", lineCode: "pedia", regionCode: "UE-1", actualValue: 250, targetValue: 500, hasTarget: true }),
    row({ period: "2026-10", lineCode: "anti_infective", regionCode: "D3", actualValue: 150, targetValue: 0 }),
    row({ period: "2026-10", lineCode: "anti_infective", regionCode: null, actualValue: 90 }),
    // Head Office: no line code, and a stray code that is not a tracked line.
    row({ period: "2026-10", lineCode: null, regionCode: "CA", actualValue: 1_000_000 }),
    row({ period: "2026-10", lineCode: "head_office", regionCode: "CA", actualValue: 2_000_000, targetValue: 5, hasTarget: true }),
    // November: CNS only, and the running month — never shown.
    row({ period: "2026-11", lineCode: "cns", actualValue: 77_777, targetValue: 1, hasTarget: true }),
  ];

  const names: Record<string, string> = { D1: "Delta (1)", D3: "Delta (3)", UE: "Upper Egypt", "UE-1": "Upper Egypt 1" };
  const result = aggregatePublishedClosingSales({ rows, publishedKeys, regionNameOf: (code) => names[code], now: NOW });
  assert.ok(result, "something is published on every line, so there is a result");

  // Headline: the newest month EVERY tracked line has published and that is over.
  assert.equal(result.period, "2026-10", "November is CNS-only and still running; October is the headline");
  assert.equal(result.totalValue, 1490, "October = 600 + 400.004 + 250 + 150 + 90, to the piastre; Head Office excluded");

  // Head Office never appears, by name or by money.
  assert.deepEqual(result.byLine.map((line) => line.name), ["CNS", "Pedia", "Anti Infective"], "sorted by value, Head Office absent");
  assert.ok(!JSON.stringify(result).toLowerCase().includes("head"), "no Head Office anywhere in the result");
  assert.equal(result.byLine.reduce((sum, line) => sum + line.value, 0), result.totalValue, "the lines add to the total");

  // Shares sum to 1, by line and by region.
  const lineShare = result.byLine.reduce((sum, line) => sum + line.share, 0);
  const regionShare = result.byRegion.reduce((sum, region) => sum + region.share, 0);
  assert.ok(Math.abs(lineShare - 1) < 1e-9, `line shares sum to 1, got ${lineShare}`);
  assert.ok(Math.abs(regionShare - 1) < 1e-9, `region shares sum to 1, got ${regionShare}`);

  // Regions as the closing names them; a row with no region is named, never dropped.
  assert.deepEqual(
    result.byRegion.map((region) => region.name),
    ["Delta (1)", "Upper Egypt", "Upper Egypt 1", "Delta (3)", "Unassigned region"],
  );

  // No unit or quantity field anywhere in what the overview receives.
  const unitKeys = keysDeep(result).filter((key) => /unit|qty|quantit/i.test(key));
  assert.deepEqual(unitKeys, [], "units of different products are never added — the result is value only");

  // monthly[]: fully published months only, ascending — September (Pedia unpublished) and November left out.
  assert.deepEqual(result.monthly, [
    { period: "2026-07", value: 500, target: 0 },
    { period: "2026-08", value: 1100, target: 1600 },
    { period: "2026-10", value: 1490, target: 1500 },
  ]);

  // Achievement: July (zero target) is ignored; each line graded on its own targeted months.
  assert.ok(result.achievement, "targeted months exist");
  assert.equal(result.achievement.fromPeriod, "2026-08", "July carries no target, so it is not graded");
  assert.equal(result.achievement.toPeriod, "2026-10");
  // CNS: Aug 800 + Oct (600 + 400.004) over 2000. Pedia: Aug 300 + Oct 250 over 1100.
  // Anti Infective: no month with a target → contributes nothing.
  assert.equal(result.achievement.sales, 2350, "July's 500 and Anti Infective's untargeted 240 stay out of the numerator");
  assert.equal(result.achievement.target, 3100);
  assert.ok(Math.abs((result.achievement.rate ?? 0) - 2350.004 / 3100) < 1e-12);

  // Zero target everywhere → achievement null, never a 0% or an Infinity.
  const untargeted = aggregatePublishedClosingSales({
    rows: rows.filter((candidate) => candidate.period === "2026-07"),
    publishedKeys,
    now: NOW,
  });
  assert.equal(untargeted?.achievement, null, "no month with a target means no achievement");

  // Nothing published on every line → null.
  assert.equal(
    aggregatePublishedClosingSales({ rows, publishedKeys: new Set(["cns|2026-10", "pedia|2026-10"]), now: NOW }),
    null,
    "a month published on two of three lines is never a headline",
  );
  assert.equal(aggregatePublishedClosingSales({ rows, publishedKeys: new Set(), now: NOW }), null);

  // Never a month still running, even if every line has a publication row for it.
  const allNovember = keysFor(["cns", "pedia", "anti_infective"], ["2026-10", "2026-11"]);
  assert.deepEqual(companyPublishedPeriods(allNovember, NOW), ["2026-10"], "November 2026 is still running in Cairo");

  // monthly[] is the headline month's year: a December headline read in January keeps its year.
  const decemberKeys = keysFor(["cns", "pedia", "anti_infective"], ["2026-11", "2026-12"]);
  const january = aggregatePublishedClosingSales({
    rows: [row({ period: "2026-12", lineCode: "cns", actualValue: 10 })],
    publishedKeys: decemberKeys,
    now: new Date("2027-01-02T10:00:00Z"),
  });
  assert.equal(january?.period, "2026-12");
  assert.deepEqual(january?.monthly.map((point) => point.period), ["2026-11", "2026-12"]);
}
