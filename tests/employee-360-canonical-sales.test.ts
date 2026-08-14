import assert from "node:assert/strict";
import {
  aggregateCanonicalEmployee360Rows,
  maskRestrictedEmployee360Rows,
  selectEmployee360RowsForFamilies,
  selectEmployee360RowsForHrIds,
  toEmployee360SalesRows,
  type CanonicalEmployee360SalesRow,
} from "../src/lib/employee-360/sales-canonical.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

// Employee 360 was the last surface answering "how much did this person sell" from the legacy
// sales_records table. It read B-158's H1 as 700,019.87 while the incentive tab, the monthly
// dashboard, the closing view and reconciliation all read 460,228.50 — a 52% overstatement, with
// every month differing. These pin the three decisions in the canonical replacement that, if
// quietly reversed, would put it back out of step with the other four surfaces.

function achievementRow(overrides: Partial<AchievementRow> = {}): AchievementRow {
  return {
    period: "2026-07",
    lineCode: "cns",
    regionCode: "LE-1",
    areaCode: "GZ6",
    areaState: "active",
    isOther: false,
    repSeatId: "seat-1",
    repHrId: "B-158",
    dmSeatId: "seat-dm",
    dmHrId: "A-001",
    productCode: "SA001",
    actualUnits: 10,
    actualValue: 1000,
    targetUnits: 8,
    targetValue: 800,
    achievementValue: 1.25,
    achievementUnits: 1.25,
    hasTarget: true,
    hasActual: true,
    ...overrides,
  };
}

function salesRow(overrides: Partial<CanonicalEmployee360SalesRow> = {}): CanonicalEmployee360SalesRow {
  return {
    employee_hr_id: "B-158",
    managerHrId: "A-001",
    line: "CNS",
    family: "Neuro",
    product: "Sample Product",
    productCode: "SA001",
    month: 7,
    year: 2026,
    sales_value: 1000,
    target_value: 800,
    ...overrides,
  };
}

export function runEmployee360CanonicalSalesTests() {
  const uploaded = new Set(["2026-07"]);

  // ── 1. The upload gate ────────────────────────────────────────────────────
  // August 2026 held ONE direct order (1,309.50 EGP) against a 17,508,935 EGP target; B-158's own
  // share of that target is 200,875.95. Letting the month through drops him from 136.6% to 66.2%
  // — under the incentive scheme's 90% floor, which pays zero. `has_actual` cannot tell a landed
  // month from a stray direct order, so the distributor-batch ledger is the only honest gate.
  const acrossMonths = aggregateCanonicalEmployee360Rows(
    [achievementRow({ period: "2026-07" }), achievementRow({ period: "2026-08", actualValue: 1309.5 })],
    uploaded,
  );
  assert.equal(acrossMonths.length, 1, "a month with no distributor upload is dropped, never carried as a 0% point");
  assert.equal(acrossMonths[0].period, "2026-07", "the surviving month is the one whose upload landed");

  // ── 2. Rows with no occupant belong to the AREA, not to a person ──────────
  assert.equal(
    aggregateCanonicalEmployee360Rows([achievementRow({ repHrId: null })], uploaded).length,
    0,
    "an unattributed row is dropped rather than credited to whoever is nearby",
  );

  // ── 3. One aggregate per (rep, period, product) ───────────────────────────
  // The engine emits a row per (rep, AREA, product), so a rep working two areas emits the same
  // product twice in one month. Summing here keeps the row count honest for `hasData`.
  const twoAreas = aggregateCanonicalEmployee360Rows(
    [achievementRow({ areaCode: "GZ6" }), achievementRow({ areaCode: "UE9" })],
    uploaded,
  );
  assert.equal(twoAreas.length, 1, "the same product in the same month collapses to one row across areas");
  assert.equal(twoAreas[0].salesValue, 2000, "…and its value is the SUM of both areas, never one of them");
  assert.equal(twoAreas[0].targetValue, 1600, "…targets sum the same way");

  // ── 4. Scoping matches the REP only ───────────────────────────────────────
  // The legacy query matched employee_hr_id alone. Matching the DM leg too would silently widen a
  // manager's total to reps the caller never asked about — a scope change disguised as an engine
  // change. Casing is folded because the engine's casing is not the repo's.
  const rows = [salesRow({ employee_hr_id: "B-158" }), salesRow({ employee_hr_id: "C-999", managerHrId: "B-158" })];
  const selected = selectEmployee360RowsForHrIds(rows, ["b-158"]);
  assert.equal(selected.length, 1, "a row whose DM matches but whose rep does not is NOT selected");
  assert.equal(selected[0].employee_hr_id, "B-158", "HR ids match case-insensitively in both directions");
  assert.equal(selectEmployee360RowsForHrIds(rows, []).length, 0, "an empty id list selects nothing, never everything");

  // ── 5. The PM path selects by family ──────────────────────────────────────
  const byFamily = selectEmployee360RowsForFamilies(
    [salesRow({ family: "Neuro" }), salesRow({ family: "Pedia" })],
    ["neuro"],
  );
  assert.equal(byFamily.length, 1, "a PM owns brands, so their sales are their families' sales");
  assert.equal(byFamily[0].family, "Neuro", "family matching is case-insensitive");

  // ── 6. Confidential products are masked by CODE ───────────────────────────
  // LA003/LA004/SS001 are the whole Head Office line. The legacy table had no product code, so it
  // matched by NAME and inherited every rename; canonical rows carry the code, so the strip is exact.
  const confidential = [
    salesRow({ productCode: "LA003", product: "Lacto Basic 1" }),
    salesRow({ productCode: "SS001", product: "Satoslim" }),
    salesRow({ productCode: "SA001", product: "Normal Product" }),
  ];
  assert.equal(
    maskRestrictedEmployee360Rows(confidential, "District Manager").length,
    1,
    "a District Manager sees only the non-confidential product",
  );
  assert.equal(
    maskRestrictedEmployee360Rows(confidential, "CEO").length,
    3,
    "the CEO sees all three — the mask is a role gate, not a blanket exclusion",
  );
  assert.deepEqual(
    maskRestrictedEmployee360Rows(confidential, "Medical Rep").map((r) => r.productCode),
    ["SA001"],
    "no confidential CODE survives for a rep, whatever the product happens to be named",
  );

  // ── 7. An unmapped SKU keeps its code, never a placeholder ────────────────
  // Collapsing unmapped products into one "—" bucket is how a real seller vanishes from Top Products.
  const named = toEmployee360SalesRows(
    aggregateCanonicalEmployee360Rows([achievementRow({ productCode: "ZZ999" })], uploaded),
    new Map(),
    new Map(),
  );
  assert.equal(named[0].product, "ZZ999", "an unmapped product falls back to its CODE so it stays countable");
  assert.equal(named[0].line, "CNS", "line codes are resolved to the official name — a user never sees a code");
  assert.equal(named[0].year, 2026, "the period is split into the year/month the aggregator groups on");
  assert.equal(named[0].month, 7, "…and the month survives as a number, not a string");
}
