import assert from "node:assert/strict";

import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { buildPortalMonthPace, type ClosingDirectRow, type MonthPaceWeeklyRep } from "../src/lib/sales/sos-month-pace-loader.ts";
import { buildMonthPace, UNNAMED_AREA_LABEL, type MonthPaceRow } from "../src/lib/sales/sos-month-pace.ts";
import type { VsTargetBound } from "../src/lib/sales/vs-target-scope.ts";

// The portal Source of Sales month-pace strip names every area — never its code (owner rule).
//
// Only the weekly rows used to carry a name, so an area with a target but no weekly row yet was labelled
// with its code. Measured on production on 16 Sept 2026: an Anti Infective rep read "UE5: weekly 0 ·
// target 46,297" where the area is Sohag1, another rep "UE2", a district manager "UE8", and a Pedia rep
// "UE1" and "UE3". The loader now names every input — targets, weekly rows and direct orders — from the
// Source of Sales area master, and with no name anywhere a row reads "Unnamed area" (owner's pick,
// 2026-09-17), still carrying its money.

const PERIOD = "2026-09";

// The Source of Sales area master's own names for these codes (production, 2026-09-17).
const AREA_NAMES: ReadonlyMap<string, string> = new Map([
  ["UE1", "Minia 1"],
  ["UE2", "Minia 2"],
  ["UE3", "Assuit 1"],
  ["UE5", "Sohag1"],
  ["UE8", "Qena 2"],
]);

function targetRow(overrides: Partial<AchievementRow> & { areaCode: string; productCode: string; targetValue: number }): AchievementRow {
  return {
    period: PERIOD,
    lineCode: "anti_infective",
    regionCode: "UE-2",
    areaState: null,
    isOther: false,
    repSeatId: null,
    repHrId: "A-501",
    dmSeatId: null,
    dmHrId: null,
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: true,
    hasActual: false,
    ...overrides,
  };
}

function weeklyRep(overrides: Partial<MonthPaceWeeklyRep> & { areaCode: string; value: number }): MonthPaceWeeklyRep {
  return { kind: "rep", areaName: null, lineName: "Anti Infective", allocatedValue: 0, products: [], ...overrides };
}

function pace(input: {
  lineCode: string;
  bound: VsTargetBound;
  areaCodes: string[] | null;
  achievement?: AchievementRow[];
  weeklyReps?: MonthPaceWeeklyRep[];
  directRows?: ClosingDirectRow[];
  areaNames?: ReadonlyMap<string, string>;
}) {
  return buildPortalMonthPace({
    period: PERIOD,
    dayOfMonth: 16,
    lineCode: input.lineCode,
    areaCodes: input.areaCodes,
    productCodes: null,
    achievement: input.achievement ?? [],
    bound: input.bound,
    weeklyReps: input.weeklyReps ?? [],
    directRows: input.directRows ?? [],
    directInWeekly: false,
    areaNames: input.areaNames ?? AREA_NAMES,
  });
}

function rowFor(rows: MonthPaceRow[], areaCode: string): MonthPaceRow {
  const row = rows.find((entry) => entry.areaCode === areaCode);
  assert.ok(row, `the strip has a row for ${areaCode}`);
  return row;
}

export function runSosMonthPaceAreaNamesTests() {
  const everyRow: MonthPaceRow[] = [];

  // ── The defect as measured: a target, and no weekly row yet ────────────────────────────────
  {
    const result = pace({
      lineCode: "anti_infective",
      bound: { kind: "self", hrId: "a-501" },
      areaCodes: ["UE5", "UE3"],
      achievement: [
        targetRow({ areaCode: "UE5", productCode: "AI01", targetValue: 30000 }),
        targetRow({ areaCode: "UE5", productCode: "AI02", targetValue: 16297 }),
        targetRow({ areaCode: "UE3", productCode: "AI01", targetValue: 10000 }),
      ],
      weeklyReps: [weeklyRep({ areaCode: "UE3", areaName: "Assuit 1", value: 4000 })],
    });
    const sohag = rowFor(result.rows, "UE5");
    assert.equal(sohag.weeklyValue, 0, "the fixture's area has no weekly row");
    assert.equal(sohag.targetValue, 46297, "and a target");
    assert.equal(sohag.areaName, "Sohag1", "an area with a target and no weekly row is labelled by its name, never its code");
    assert.equal(rowFor(result.rows, "UE3").areaName, "Assuit 1", "an area with weekly sales keeps its name");
    everyRow.push(...result.rows);
  }

  // ── Direct orders only: no target loaded yet, no weekly upload (a district manager's area) ──
  {
    const result = pace({
      lineCode: "anti_infective",
      bound: { kind: "areas", areaCodes: new Set(["UE8"]), lineCodes: new Set(["anti_infective"]) },
      areaCodes: ["UE8"],
      directRows: [{ area_code: "ue8", product_code: "AI01", sales_value: "1250.50" }],
    });
    const qena = rowFor(result.rows, "UE8");
    assert.equal(qena.directValue, 1250.5, "the fixture's area has direct orders and nothing else");
    assert.equal(qena.areaName, "Qena 2", "an area reached only by direct orders is labelled by its name");
    everyRow.push(...result.rows);
  }

  // ── A weekly row whose own "name" is its code (the seat index falls back to the code) ───────
  {
    const result = pace({
      lineCode: "pedia",
      bound: { kind: "line", lineCodes: new Set(["pedia"]) },
      areaCodes: null,
      weeklyReps: [weeklyRep({ kind: "vacant", areaCode: "UE2", areaName: "UE2", lineName: "Pedia", value: 900, allocatedValue: 900 })],
    });
    assert.equal(rowFor(result.rows, "UE2").areaName, "Minia 2", "the area master names a weekly row the organogram left nameless");
    everyRow.push(...result.rows);
  }

  // ── An area missing from the master ─────────────────────────────────────────────────────────
  {
    const result = pace({
      lineCode: "pedia",
      bound: { kind: "line", lineCodes: new Set(["pedia"]) },
      areaCodes: null,
      areaNames: new Map(),
      achievement: [targetRow({ lineCode: "pedia", areaCode: "ZZ9", productCode: "PD01", targetValue: 5000 })],
      weeklyReps: [weeklyRep({ areaCode: "UE1", areaName: "Minia 1", lineName: "Pedia", value: 700 })],
    });
    assert.equal(rowFor(result.rows, "UE1").areaName, "Minia 1", "the weekly row's own name still names an area the master lacks");
    const unnamed = rowFor(result.rows, "ZZ9");
    assert.equal(unnamed.areaName, "Unnamed area", "no name anywhere reads \"Unnamed area\" (owner's pick), never the code");
    assert.equal(unnamed.targetValue, 5000, "and the row keeps its money");
    assert.equal(result.totals.targetValue, 5000, "which still counts in the totals");
    everyRow.push(...result.rows);
  }

  // ── A master row with a blank name: loadAreaNameMap hands back the code in its place ──────────
  {
    const result = pace({
      lineCode: "pedia",
      bound: { kind: "line", lineCodes: new Set(["pedia"]) },
      areaCodes: null,
      areaNames: new Map([["UE9", "UE9"]]),
      achievement: [targetRow({ lineCode: "pedia", areaCode: "UE9", productCode: "PD01", targetValue: 8000 })],
      weeklyReps: [weeklyRep({ areaCode: "UE9", areaName: "Beni Suef", lineName: "Pedia", value: 1200 })],
    });
    assert.equal(
      rowFor(result.rows, "UE9").areaName,
      "Beni Suef",
      "a code the master hands back for a blank name is no name, so the weekly row's own name labels the area",
    );
    everyRow.push(...result.rows);
  }

  // ── The builder: a name that is only the code again is not a name ────────────────────────────
  {
    const result = buildMonthPace({
      period: PERIOD,
      dayOfMonth: 16,
      daysInMonth: 30,
      targets: [{ areaCode: "UE5", areaName: "ue5", targetValue: 100 }],
      weekly: [{ areaCode: "UE5", areaName: "Sohag1", value: 10, allocatedValue: 0 }],
    });
    assert.equal(result.rows[0].areaName, "Sohag1", "a code handed over as a name, in any case, gives way to the real name");
    assert.equal(UNNAMED_AREA_LABEL, "Unnamed area", "the owner's wording");
    everyRow.push(...result.rows);
  }

  assert.ok(everyRow.length >= 6, "every case above produced its rows");
  for (const row of everyRow) {
    assert.notEqual(row.areaName.trim().toUpperCase(), row.areaCode.trim().toUpperCase(), `${row.areaCode} is never labelled with its code`);
  }
}
