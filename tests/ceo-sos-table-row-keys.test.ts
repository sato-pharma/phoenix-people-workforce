import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildSourceOfSalesDashboard,
  type SourceOfSalesSummaryRecord,
} from "../src/lib/sales/monthly-distributor-import.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// React warned "Encountered two children with the same key" on every surface that renders
// CeoSosTables — /admin, /admin/ceo-command-center, /admin/sfe-command-center. PR #2837 fixed it by
// keying <tr> on the group's `key`; hours later an uncommitted working-tree edit swapped it to
// `code`, which reproduced the same class of warning with the raw codes (CA, AB, GZ, OT, D1, UE)
// instead of the labels. Nothing went red, because no test pinned it. This is that test.
//
// Why only `key` works, from `SourceOfSalesDashboardGroup`:
//   • `key`   — `group_key`, e.g. `"CA|Cairo"` (regionCode|regionName at import time). It is the
//               field `aggregateDashboardGroups` keys its own Map on, so it is unique BY
//               CONSTRUCTION: one row out per distinct key in.
//   • `code`  — `string | null`. Several groups legitimately share one region/product code, and it
//               can be null outright, so `key={row.code}` can even render `key={null}`.
//   • `label` — self-healed to the master table's name by loadSourceOfSalesDashboard, so several
//               groups can still share one display name.
//
// Live /admin on 2026-09-01 showed the shape this fixture models: 23 region rows carrying only 7
// distinct labels — Cairo x5, Alex-BHR x4, Others x4, Delta (1) x3, Upper Egypt x3, Delta (2) x2,
// Giza x2.
//
// READ THAT SHAPE AS THE BUG, NOT AS THE SPEC. The owner reported those repeats the same day and
// they are fixed: `loadSourceOfSalesDashboard` now merges groups on the master-resolved CODE
// (`mergeDashboardGroupsByCode`), so the 23 rows are 7. This test still asserts 5 rows from the
// same fixture because it exercises the PURE builder, which has no master tables and therefore
// still emits one row per `group_key` — that is correct and load-bearing, and the merge deliberately
// lives one level up. What survives the fix is the reason for keying on `key`: two groups whose
// codes the master cannot adjudicate stay unmerged and can still collide on a label. So `key` is
// still the only safe React key — but a repeated label on the RENDERED page is now a finding.
// tests/sos-dashboard-group-merge.test.ts pins the merge itself.
function summary(input: Partial<SourceOfSalesSummaryRecord> & { groupType: string }): SourceOfSalesSummaryRecord {
  return {
    batchId: "batch-1",
    groupCode: null,
    groupKey: input.groupLabel ?? input.groupType,
    groupLabel: input.groupType,
    officialLine: null,
    rowCount: 1,
    totalBonusQty: 0,
    totalQty: 1,
    totalValue: 0,
    ...input,
  };
}

/**
 * `rawName` is the distributor sheet's own spelling, which is what `group_key` is built from at
 * import time; `healedLabel` is what the master-table self-heal later rewrites `label` to. Passing
 * them separately is the whole point — it is exactly how two rows end up sharing a label (and a
 * code) while still being two distinct groups.
 */
function region(code: string | null, rawName: string, healedLabel: string, value: number): SourceOfSalesSummaryRecord {
  return summary({
    groupCode: code,
    groupKey: `${code ?? ""}|${rawName}`,
    groupLabel: healedLabel,
    groupType: "region",
    totalValue: value,
  });
}

function product(code: string, label: string, line: string, value: number): SourceOfSalesSummaryRecord {
  return summary({
    groupCode: code,
    groupKey: `${code}|${label}|${line}`,
    groupLabel: label,
    groupType: "product",
    officialLine: line,
    totalValue: value,
  });
}

// No `as` cast — the fixture is checked against the real type, so a field drifting here is a
// compile error rather than a silently-wrong test.
const summaries: SourceOfSalesSummaryRecord[] = [
  region("CA", "Cairo", "Cairo", 3_300_000),
  region("CA", "CAIRO", "Cairo", 8_000),
  region("CA", "Cairo Est", "Cairo", 320),
  region(null, "Cairo", "Cairo", 111),
  region("UE", "Upper Egypt", "Upper Egypt", 8_300_000),
  product("LB1", "Lacto Basic 1", "CNS", 25_400_000),
  product("LB1", "Lacto Basic 1", "Pedia", 1_500_000),
  product("TF80", "Tebofortine Forte 80", "CNS", 4_900_000),
];

export function runCeoSosTableRowKeysTests() {
  const dashboard = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-08"],
    batches: [],
    period: "2026-08",
    summaries,
  });

  // ── The data really does collide: `key` is unique, `code` and `label` are not ──────────────
  const regionKeys = dashboard.byRegion.map((group) => group.key);
  const regionCodes = dashboard.byRegion.map((group) => group.code);
  const regionLabels = dashboard.byRegion.map((group) => group.label);

  assert.equal(
    dashboard.byRegion.length,
    5,
    "five distinct group_keys stay five rows — the grouping Map keys on group_key, so same-code/same-label groups are never merged away",
  );
  assert.equal(
    new Set(regionKeys).size,
    regionKeys.length,
    "`key` is unique across region rows — it is the only field React can safely key a <tr> on",
  );
  assert.ok(
    new Set(regionCodes).size < regionCodes.length,
    "`code` REPEATS across region rows (CA three times) — keying on it duplicates React keys, which is the regression this test exists to catch",
  );
  assert.ok(
    regionCodes.includes(null),
    "`code` is nullable, so key={row.code} can render key={null} — it is not merely non-unique, it is not always a string",
  );
  assert.ok(
    new Set(regionLabels).size < regionLabels.length,
    "`label` REPEATS too (four Cairos) — the master-table self-heal collapses distinct regions onto one display name, which was PR #2837's original bug",
  );

  const productKeys = dashboard.byProduct.map((group) => group.key);
  const productCodes = dashboard.byProduct.map((group) => group.code);
  assert.equal(
    new Set(productKeys).size,
    productKeys.length,
    "`key` is unique across product rows — group_key carries the official line, so one product code on two lines is two rows",
  );
  assert.ok(
    new Set(productCodes).size < productCodes.length,
    "`code` REPEATS across product rows (LB1 on CNS and on Pedia) — the by-product table has the same trap as by-region",
  );

  // ── The UI actually consumes that unique key ───────────────────────────────────────────────
  const tablesSource = readSource("../src/components/admin/ceo-sos-tables.tsx");
  const rowKeyFields = [...tablesSource.matchAll(/<tr key=\{row\.(\w+)\}/g)].map((match) => match[1]);

  // A source pin that matches nothing passes vacuously, which is indistinguishable from a pass.
  assert.ok(
    rowKeyFields.length >= 2,
    "the <tr key={row.X}> pattern still matches both SoS tables — if it matches nothing this whole check is silently inert",
  );
  for (const field of rowKeyFields) {
    assert.equal(
      field,
      "key",
      `every SoS <tr> keys on row.key, never row.${field} — code is nullable and repeats, label is self-healed onto one name`,
    );
  }

  assert.match(
    tablesSource,
    /type RegionRow\s*=\s*\{\s*key: string;/,
    "RegionRow carries the unique `key`, so the component cannot be handed rows that only have a `code`",
  );
  assert.match(
    tablesSource,
    /type ProductRow\s*=\s*\{\s*key: string;/,
    "ProductRow carries the unique `key`, so the component cannot be handed rows that only have a `code`",
  );

  // ── …and the CEO loader is what supplies it ────────────────────────────────────────────────
  const commandCenterSource = readSource("../src/lib/ceo/command-center.ts");
  assert.match(
    commandCenterSource,
    /byRegion: Array<\{ key: string;/,
    "the CEO command-center contract exposes `key` on byRegion — dropping it is what forces the UI onto a non-unique field",
  );
  assert.match(
    commandCenterSource,
    /byProduct: Array<\{ key: string;/,
    "the CEO command-center contract exposes `key` on byProduct",
  );
  assert.match(
    commandCenterSource,
    /key: r\.key,/,
    "the byRegion mapper forwards the group's unique key rather than re-deriving one from code/label",
  );
  assert.match(
    commandCenterSource,
    /key: p\.key,/,
    "the byProduct mapper forwards the group's unique key rather than re-deriving one from code/label",
  );
}
