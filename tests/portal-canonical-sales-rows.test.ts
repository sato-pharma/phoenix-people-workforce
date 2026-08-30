import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { getMergedAreaName } from "../src/lib/sales/closing-area-merges.ts";
import {
  aggregateCanonicalPortalRows,
  filterCanonicalPortalRows,
  selectCanonicalRowsForHrIds,
  type CanonicalPortalSalesRow,
} from "../src/lib/employee-portal/portal-sales-canonical.ts";

// Spread-merged, NOT `??`-defaulted: `repHrId: null` is a case this fixture has to be able to
// express (an unoccupied seat), and `??` would silently substitute the default for it.
function row(overrides: Partial<AchievementRow> & { period: string }): AchievementRow {
  const merged: AchievementRow = {
    lineCode: "cns",
    regionCode: "AB",
    areaCode: "D16",
    areaState: "occupied",
    isOther: false,
    repSeatId: "SEAT-CNS-REP-D16",
    repHrId: "b-158",
    dmSeatId: "SEAT-CNS-DM-AB",
    dmHrId: "b-119",
    productCode: "TE003",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: false,
    ...overrides,
  };
  return {
    ...merged,
    hasTarget: "hasTarget" in overrides ? merged.hasTarget : merged.targetValue != null,
    hasActual: "hasActual" in overrides ? merged.hasActual : merged.actualValue !== 0,
  };
}

function portalRow(overrides: Partial<CanonicalPortalSalesRow> = {}): CanonicalPortalSalesRow {
  return {
    hrId: "B-158",
    managerHrId: "B-119",
    family: "Tebofortin",
    line: "CNS",
    month: 7,
    period: "2026-07",
    product: "Tebofortin 40mg",
    salesType: "",
    salesUnits: 10,
    salesValue: 1_000,
    targetValue: 900,
    territory: "Cairo North",
    year: 2026,
    ...overrides,
  };
}

export function runPortalCanonicalSalesRowsTests() {
  const july = new Set(["2026-07"]);

  // ── The merged-area collision ──────────────────────────────────────────────
  // applyAchievementAreaMerges rewrites Fayoum and Beni Suef onto ONE area code without
  // summing, so two rows legitimately arrive sharing (rep, period, area, product).
  // buildPortalSalesDashboardMetrics then deduplicates targets by taking the MAX per that exact
  // key (src/lib/sales/metrics.ts, the builder the portal actually calls) — correct for the
  // legacy view's Retail/Stores echo, silent data loss for these. Summing here is what makes
  // that downstream MAX a no-op.
  const mergedArea = aggregateCanonicalPortalRows(
    [
      row({ period: "2026-07", areaCode: "FY1", actualValue: 300_000, actualUnits: 30, targetValue: 250_000 }),
      row({ period: "2026-07", areaCode: "FY1", actualValue: 200_000, actualUnits: 20, targetValue: 150_000 }),
    ],
    july,
  );
  assert.equal(mergedArea.length, 1, "two rows on one merged area code fold into a single aggregate");
  assert.equal(
    mergedArea[0]?.salesValue,
    500_000,
    "both halves of a merged area count — keeping only one would under-report the rep's sales",
  );
  assert.equal(
    mergedArea[0]?.targetValue,
    400_000,
    "targets sum too; a MAX downstream would keep 250,000 and silently drop the other 150,000",
  );

  // ── The August trap ────────────────────────────────────────────────────────
  // 2026-08-10: ONE direct order (1,309.50 EGP) against a 17,508,935 EGP target. A month
  // whose distributor upload has not landed is not a data point — it is a 0% month painted
  // onto the screen the field force opens daily.
  const strayAugust = aggregateCanonicalPortalRows(
    [
      row({ period: "2026-07", actualValue: 1_000_000, targetValue: 1_000_000 }),
      row({ period: "2026-08", actualValue: 1_309.5, targetValue: 17_508_935 }),
    ],
    july,
  );
  assert.deepEqual(
    strayAugust.map((aggregate) => aggregate.period),
    ["2026-07"],
    "a month with a direct order but no distributor upload is excluded, not shown as ~0%",
  );

  // ── An unattributed row belongs to the area, never to a person ─────────────
  const unattributed = aggregateCanonicalPortalRows(
    [row({ period: "2026-07", repHrId: null, actualValue: 5_000, targetValue: 1_000 })],
    july,
  );
  assert.deepEqual(
    unattributed,
    [],
    "a vacant-seat row must never be credited to whoever the portal happened to ask about",
  );

  // ── The manager's reach ────────────────────────────────────────────────────
  // The legacy query matched `hr_id.eq.X OR manager_hr_id.eq.X`, so a DM saw their reports'
  // rows. Narrowing that to the rep alone would empty every manager's page.
  const rows = [
    portalRow({ hrId: "B-158", managerHrId: "B-119" }),
    portalRow({ hrId: "B-144", managerHrId: "B-119" }),
    portalRow({ hrId: "B-201", managerHrId: "B-300" }),
  ];
  assert.deepEqual(
    selectCanonicalRowsForHrIds(rows, ["B-119"]).map((r) => r.hrId),
    ["B-158", "B-144"],
    "asking about a DM returns their reports' rows, each still owned by the rep who sold it",
  );
  assert.deepEqual(
    selectCanonicalRowsForHrIds(rows, ["b-158"]).map((r) => r.hrId),
    ["B-158"],
    "a lower-cased request still matches — HR-id casing differs between the engine and the portal",
  );
  assert.deepEqual(
    selectCanonicalRowsForHrIds(rows, []),
    [],
    "asking about nobody returns nothing, never the whole company",
  );

  // ── Filters ───────────────────────────────────────────────────────────────
  // resolveSalesFilterValues hands over a line NAME plus its aliases; the legacy query matched
  // them with ilike, so the replacement has to be case-insensitive too.
  assert.equal(
    filterCanonicalPortalRows(rows, { line: ["cns", "O-3"] }).length,
    3,
    "an alias list matches the rendered line name case-insensitively, as the old ilike did",
  );
  assert.equal(
    filterCanonicalPortalRows(rows, { line: ["Pedia"] }).length,
    0,
    "and a line the rows do not belong to matches nothing",
  );
  assert.equal(
    filterCanonicalPortalRows(rows, { period: "2026-06" }).length,
    0,
    "period filtering is exact — a portal asking for June must not be handed July",
  );

  // The canonical engine has no Retail/Stores split, so sales type is blank on every row and
  // the portal's dropdown (built from these rows, falsy values dropped) offers no options.
  assert.deepEqual(
    [...new Set(rows.map((r) => r.salesType))],
    [""],
    "a fabricated sales-type token would put a filter on screen that silently discards data",
  );

  // ── The merged area keeps BOTH halves' name ─────────────────────────────────
  // The sales fold correctly (asserted above), but the portal row's territory label must read
  // "Fayoum - Beni Suef", not the bare GZ6 name "Fayoum". The label is built in
  // loadAllCanonicalPortalSalesRows, which needs the DB, so the guard is on the source: the
  // territory must resolve through getMergedAreaName. Without it a rep sees "Fayoum" with Beni
  // Suef's sales silently folded in and no sign the two are one territory.
  assert.match(
    readFileSync("src/lib/employee-portal/portal-sales-canonical.ts", "utf8"),
    /territory:\s*getMergedAreaName\(/,
    "portal territory must label the merged Pedia row as 'Fayoum - Beni Suef' via getMergedAreaName",
  );
  assert.equal(
    getMergedAreaName("pedia", "GZ6"),
    "Fayoum - Beni Suef",
    "Pedia's merged GZ6 row carries the combined Fayoum - Beni Suef name",
  );
  assert.equal(
    getMergedAreaName("cns", "GZ6"),
    null,
    "CNS no longer merges — owner split Fayoum and Beni Suef back into two areas on 2026-08-30",
  );
  assert.equal(
    getMergedAreaName("anti_infective", "GZ6"),
    null,
    "Anti Infective keeps Fayoum and Beni Suef separate — it has no merged name",
  );
}
