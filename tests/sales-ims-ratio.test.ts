import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  IMS_NON_OT_TOTAL,
  IMS_OTHERS_REGION_CODE,
  IMS_OTHERS_TOTAL,
  IMS_TOLERANCE,
  summarizeImsRatios,
  type ImsAreaRow,
  type ImsRegionRow,
} from "../src/lib/sales/ims-ratio.ts";
import { MASTER_DEFINITIONS } from "../src/lib/sales/master-data/definitions.ts";
import { othersRuleInvalidReason } from "../src/lib/sales/master-data/import-service.ts";

// Drift guard for the Source-of-Sales IMS (market share) ratios.
//
// The model is split across two tables on purpose: the 39 non-OT areas carry a per-area ratio, and
// the OT ("Others") residual sits ONCE on the region row, because OT's area list is volatile (3
// areas to 9 in a single day) and its share must never be split per area. Nothing in the schema
// ties those two halves together, so the only thing standing between an edit in the Database
// Mapping console and a silently wrong market-share denominator is this check: it must add to 1.
//
// This reads supabase/migrations — the migrations that actually define live schema. It must NEVER
// be pointed at supabase/_migrations_archive: three existing guard tests were found reading that
// archive and passing on statements the database does not have.
export function runSalesImsRatioTests() {
  const MIGRATIONS_DIR = "supabase/migrations";

  // ── Fixtures ───────────────────────────────────────────────────────────────
  /** A minimal but structurally faithful master: non-OT areas summing to 0.9503 + OT at region. */
  function buildAreas(overrides: Partial<ImsAreaRow>[] = []): ImsAreaRow[] {
    const base: ImsAreaRow[] = [
      { area_code: "AB1", region_code: "AB", active: true, ims_ratio: 0.5 },
      { area_code: "AB2", region_code: "AB", active: true, ims_ratio: 0.4503 },
      { area_code: "OT1", region_code: "OT", active: true, ims_ratio: null },
      { area_code: "OT2", region_code: "OT", active: true, ims_ratio: null },
    ];
    return base.map((row) => {
      const override = overrides.find((o) => o.area_code === row.area_code);
      return override ? { ...row, ...override } : row;
    });
  }

  const okRegions: ImsRegionRow[] = [
    { region_code: "AB", ims_ratio: null },
    { region_code: "OT", ims_ratio: IMS_OTHERS_TOTAL },
  ];

  // ── 1. The healthy model passes ────────────────────────────────────────────
  const healthy = summarizeImsRatios(buildAreas(), okRegions);
  assert.equal(healthy.ok, true, `healthy master should pass, got: ${healthy.problems.join(" ")}`);
  assert.ok(Math.abs(healthy.nonOtTotal - IMS_NON_OT_TOTAL) <= IMS_TOLERANCE);
  assert.ok(Math.abs(healthy.othersTotal - IMS_OTHERS_TOTAL) <= IMS_TOLERANCE);
  assert.ok(Math.abs(healthy.total - 1) <= IMS_TOLERANCE);
  assert.deepEqual(healthy.areasMissingRatio, []);
  assert.deepEqual(healthy.otAreasWithRatio, []);

  // ── 2. Float summation must not trip the check ─────────────────────────────
  // The real 39 values summed as IEEE-754 doubles do not land on 0.9503 exactly; that is precisely
  // why the comparison is tolerance-based. Assert BOTH: the float sum is off, and we still pass.
  const REAL_RATIOS = [
    0.0067, 0.0104, 0.0112, 0.0112, 0.0122, 0.0123, 0.0144, 0.0146, 0.0149, 0.0162,
    0.0183, 0.0184, 0.0203, 0.0203, 0.0204, 0.0204, 0.0207, 0.0212, 0.0229, 0.0241,
    0.0258, 0.0263, 0.0269, 0.0272, 0.0275, 0.0276, 0.0285, 0.0291, 0.0291, 0.0296,
    0.0316, 0.0322, 0.0329, 0.0341, 0.0352, 0.0405, 0.0431, 0.0446, 0.0474,
  ];
  assert.equal(REAL_RATIOS.length, 39, "expected exactly 39 non-OT area ratios");

  const realAreas: ImsAreaRow[] = REAL_RATIOS.map((ratio, index) => ({
    area_code: `A${index}`,
    region_code: "AB",
    active: true,
    ims_ratio: ratio,
  }));
  const realSummary = summarizeImsRatios(realAreas, okRegions);
  assert.equal(
    realSummary.ok,
    true,
    `real 39 ratios should pass within tolerance, got: ${realSummary.problems.join(" ")}`,
  );

  // ── 3. Drift is actually caught (the test would be worthless otherwise) ────
  const drifted = summarizeImsRatios(
    buildAreas([{ area_code: "AB1", ims_ratio: 0.51 }]),
    okRegions,
  );
  assert.equal(drifted.ok, false, "a 0.01 drift in one area must be caught");
  assert.ok(
    drifted.problems.some((p) => p.includes("expected 0.9503")),
    `expected a non-OT total problem, got: ${drifted.problems.join(" ")}`,
  );

  // A drift SMALLER than tolerance is fine; one just above it is not.
  assert.equal(
    summarizeImsRatios(buildAreas([{ area_code: "AB1", ims_ratio: 0.5 + 1e-9 }]), okRegions).ok,
    true,
    "sub-tolerance noise must not fail the check",
  );
  assert.equal(
    summarizeImsRatios(buildAreas([{ area_code: "AB1", ims_ratio: 0.5 + 1e-4 }]), okRegions).ok,
    false,
    "a drift above tolerance must fail the check",
  );

  // ── 4. The Others rule is enforced ─────────────────────────────────────────
  const splitOthers = summarizeImsRatios(
    buildAreas([{ area_code: "OT1", ims_ratio: 0.0248 }, { area_code: "OT2", ims_ratio: 0.0249 }]),
    [...okRegions.filter((r) => r.region_code !== "OT"), { region_code: "OT", ims_ratio: null }],
  );
  assert.equal(splitOthers.ok, false, "splitting Others across OT areas must be rejected");
  assert.deepEqual(splitOthers.otAreasWithRatio, ["OT1", "OT2"]);
  assert.ok(
    splitOthers.problems.some((p) => p.includes("must stay at region level")),
    `expected an Others-rule problem, got: ${splitOthers.problems.join(" ")}`,
  );

  // A missing OT region ratio breaks the total.
  const missingOthers = summarizeImsRatios(buildAreas(), [{ region_code: "OT", ims_ratio: null }]);
  assert.equal(missingOthers.ok, false, "a missing OT region ratio must be caught");
  assert.ok(missingOthers.problems.some((p) => p.includes("expected exactly 1")));

  // ── 5. A newly added area with no ratio is reported, not silently ignored ──
  const newArea = summarizeImsRatios(
    [...buildAreas(), { area_code: "AB3", region_code: "AB", active: true, ims_ratio: null }],
    okRegions,
  );
  assert.equal(newArea.ok, false, "an active non-OT area without a ratio must be reported");
  assert.deepEqual(newArea.areasMissingRatio, ["AB3"]);

  // Inactive areas are excluded from the sum, so retiring an area does not fail the check.
  const inactive = summarizeImsRatios(
    [...buildAreas(), { area_code: "AB9", region_code: "AB", active: false, ims_ratio: null }],
    okRegions,
  );
  assert.equal(inactive.ok, true, `inactive areas must be ignored, got: ${inactive.problems.join(" ")}`);

  // ── 6. The migration on disk must match the constants above ───────────────
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f))
    .sort();

  const migrationName = files.find((f) => f.endsWith("_source_of_sales_ims_ratio.sql"));
  assert.ok(migrationName, "the IMS ratio migration must exist in supabase/migrations");

  const rawSql = readFileSync(`${MIGRATIONS_DIR}/${migrationName}`, "utf8");
  // Strip line comments so prose in the header can never satisfy an assertion below.
  const sql = rawSql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  // Both columns are added, nullable, and range-constrained.
  for (const table of ["source_of_sales_areas", "source_of_sales_regions"]) {
    assert.ok(
      new RegExp(`alter table public\\.${table}\\s+add column if not exists ims_ratio numeric`, "i").test(sql),
      `${table} must gain a nullable numeric ims_ratio column`,
    );
    assert.ok(
      new RegExp(`check \\(ims_ratio is null or \\(ims_ratio >= 0 and ims_ratio <= 1\\)\\)`, "i").test(sql),
      `${table} must constrain ims_ratio to the 0..1 domain`,
    );
  }
  // A percent-shaped value (3.41) must be rejected by that constraint, not stored.
  assert.equal(
    /ims_ratio <= 1\b/.test(sql),
    true,
    "the upper bound must be 1 (fraction), not 100 (percent)",
  );

  // Every ('CODE', 0.xxxx) pair loaded into the areas table.
  const pairs = [...sql.matchAll(/\(\s*'([A-Z]{1,2}\d{1,2})'\s*,\s*(0\.\d+)\s*\)/g)].map((m) => ({
    areaCode: m[1],
    ratio: Number(m[2]),
  }));

  assert.equal(pairs.length, 39, `expected 39 area ratio pairs in the migration, found ${pairs.length}`);
  assert.equal(
    new Set(pairs.map((p) => p.areaCode)).size,
    39,
    "area codes in the migration must be unique",
  );
  assert.deepEqual(
    pairs.filter((p) => p.areaCode.startsWith(IMS_OTHERS_REGION_CODE)).map((p) => p.areaCode),
    [],
    "no OT area may receive a per-area ratio in the migration",
  );
  for (const pair of pairs) {
    assert.ok(
      pair.ratio > 0 && pair.ratio <= 1,
      `${pair.areaCode} ratio ${pair.ratio} is outside the 0..1 fraction domain`,
    );
  }

  const migrationSum = pairs.reduce((sum, p) => sum + p.ratio, 0);
  assert.ok(
    Math.abs(migrationSum - IMS_NON_OT_TOTAL) <= IMS_TOLERANCE,
    `migration ratios sum to ${migrationSum.toFixed(6)}, expected ${IMS_NON_OT_TOTAL}`,
  );

  // The migration's ratios and the constants must describe the same model.
  assert.deepEqual(
    pairs.map((p) => p.ratio).sort((a, b) => a - b),
    [...REAL_RATIOS].sort((a, b) => a - b),
    "the migration's ratios must match the 39 values this test asserts against",
  );

  // The OT residual is written once, at region level, and completes the total.
  assert.ok(
    new RegExp(`set ims_ratio = ${IMS_OTHERS_TOTAL}[\\s\\S]{0,120}?where region_code = '${IMS_OTHERS_REGION_CODE}'`, "i").test(sql),
    `the migration must set the OT region ratio to ${IMS_OTHERS_TOTAL}`,
  );
  assert.ok(
    Math.abs(migrationSum + IMS_OTHERS_TOTAL - 1) <= IMS_TOLERANCE,
    "the migration's area ratios plus the OT region ratio must total exactly 1",
  );

  // The migration must self-verify on apply, so a bad load fails loudly instead of landing.
  assert.ok(/raise exception/i.test(sql), "the migration must assert its own totals on apply");

  // ── Write-time guard on the Others rule ────────────────────────────────────
  // summarizeImsRatios only DETECTS a broken model, after the fact. othersRuleInvalidReason is what
  // stops one being written: the 0..1 percent bound happily accepts 0.02 on an OT area, which is a
  // perfectly valid fraction and still pushes the model past 1.
  const areasDef = MASTER_DEFINITIONS.areas;
  const imsColumn = areasDef.columns.find((column) => column.key === "ims_ratio");
  assert.ok(imsColumn, "the areas master must still declare an ims_ratio column");
  assert.equal(imsColumn.type, "percent", "ims_ratio must stay a percent column");
  assert.equal(imsColumn.locked, false, "ims_ratio must stay editable — the owner edits it in the UI");

  const otRow = { area_code: "OT5", region_code: IMS_OTHERS_REGION_CODE };
  const nonOtRow = { area_code: "AB1", region_code: "AB" };

  assert.ok(
    othersRuleInvalidReason(areasDef, imsColumn, 0.02, otRow),
    "a ratio on an OT area must be rejected even though 0.02 is a valid fraction",
  );
  assert.equal(
    othersRuleInvalidReason(areasDef, imsColumn, "", otRow),
    null,
    "clearing an OT area's ratio must stay allowed — NULL is the correct state",
  );
  assert.equal(
    othersRuleInvalidReason(areasDef, imsColumn, 0.02, nonOtRow),
    null,
    "non-OT areas must still accept a per-area ratio",
  );
  assert.ok(
    othersRuleInvalidReason(areasDef, imsColumn, 0.02, { area_code: "OT5", region_code: " ot " }),
    "region_code must be compared after normalizeCode, so ' ot ' is caught like 'OT'",
  );
  assert.equal(
    othersRuleInvalidReason(MASTER_DEFINITIONS.regions, imsColumn, 0.0497, { region_code: IMS_OTHERS_REGION_CODE }),
    null,
    "the OT REGION row is exactly where the Others share belongs — never blocked",
  );

  console.log("sales IMS ratio tests passed");
}
