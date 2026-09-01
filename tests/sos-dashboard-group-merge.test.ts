import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  mergeDashboardGroupsByCode,
  type SourceOfSalesDashboardGroup,
} from "../src/lib/sales/monthly-distributor-import.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// The Monthly Sales Intelligence panel showed the same region several times over, each row
// visually identical. Reported by the owner on 2026-09-01 looking at /admin: "the regions are
// deduplicating".
//
// Cause: a summary row's `group_key` is `code|name` AS CAPTURED AT IMPORT TIME, so one code that
// arrived under two different region names in two different sheets became two groups. The label
// heal in `loadSourceOfSalesDashboard` then rewrote BOTH to the master name — merging the display
// while leaving the rows split. Measured on production period 2026-07 by running the real loader
// before and after:
//
//     regions   23 rows ->   7    16 merged
//     areas    101 rows ->  55    46 merged (55 = 50 named areas + 5 EMPTY-code unmapped rows)
//     bricks   504 rows -> 504    0 merged — bricks were already clean
//     products  25 rows ->  25    unchanged; product keys carry no region name
//
// The four rows behind the "Alex-BHR" repeat, verbatim from production, are the fixture below.
// Every period 2026-01..2026-07 is affected. No value was ever lost or double-counted: the 16
// phantom REGION rows held EGP 24,266 of 61,641,432 (0.04%), split off the real row.
//
// Whatever still repeats on screen after the fix carries an empty code — unmapped sales — or is a
// name reused across two real codes (فوه is two bricks, B200-5 and B199-9). Both are left split on
// purpose, so a repeat is now a DATA finding rather than a grouping defect.
//
// The fix makes IDENTITY the master-resolved code rather than the import-time key. This test pins
// the three properties that matter: it merges what the master vouches for, it never merges what
// the master cannot adjudicate, and it is exactly sum-preserving.
function group(
  code: string | null,
  rawName: string,
  value: number,
  extra: Partial<SourceOfSalesDashboardGroup> = {},
): SourceOfSalesDashboardGroup {
  return {
    code,
    key: `${code ?? ""}|${rawName}`,
    label: rawName,
    line: null,
    rowCount: 1,
    totalBonusQty: 0,
    totalQty: 1,
    totalValue: value,
    ...extra,
  };
}

/** The production region master: AB → Alex-BHR, CA → Cairo. It does NOT know "ZZ". */
const REGION_MASTER = new Map<string, string>([
  ["AB", "Alex-BHR"],
  ["CA", "Cairo"],
]);
const resolveRegion = (code: string) => {
  const name = REGION_MASTER.get(code);
  return name ? { label: name } : null;
};

export function runSosDashboardGroupMergeTests() {
  // ── The exact production shape: code AB arrived under four different names ──────────────────
  const alexBhrSplit: SourceOfSalesDashboardGroup[] = [
    group("AB", "Alex-BHR", 6_596_149),
    group("AB", "Cairo", 2_379),
    group("AB", "Giza", 1_320),
    group("AB", "Delta (1)", 111),
  ];

  const mergedAlex = mergeDashboardGroupsByCode(alexBhrSplit, resolveRegion);

  assert.equal(
    mergedAlex.length,
    1,
    "four groups carrying region code AB collapse to ONE row — this is the reported bug: they rendered as four identical 'Alex-BHR' rows because grouping used the import-time key while the label came from the master",
  );
  assert.equal(
    mergedAlex[0].label,
    "Alex-BHR",
    "the surviving row carries the MASTER name, not whichever spelling happened to sort first",
  );
  assert.equal(
    mergedAlex[0].totalValue,
    6_599_959,
    "the merged row is the exact sum 6,596,149 + 2,379 + 1,320 + 111 — no value is dropped and none is counted twice, which is why this was only ever a display defect",
  );
  assert.equal(
    mergedAlex[0].rowCount,
    4,
    "rowCount sums too — a merge that only added money would understate how many source rows are behind the figure",
  );
  assert.equal(
    mergedAlex[0].totalQty,
    4,
    "totalQty sums as well, so units stay consistent with value",
  );

  // ── Sum preservation is the whole safety argument: merging can never move the total ─────────
  const sumOf = (groups: SourceOfSalesDashboardGroup[]) =>
    groups.reduce((total, row) => total + row.totalValue, 0);

  const mixed: SourceOfSalesDashboardGroup[] = [
    group("AB", "Alex-BHR", 6_596_149),
    group("AB", "Cairo", 2_379),
    group("CA", "Cairo", 3_348_753),
    group("CA", "Giza", 8_072),
    group("ZZ", "Unknown One", 500),
    group("ZZ", "Unknown Two", 250),
    group(null, "No Code At All", 42),
  ];

  const mergedMixed = mergeDashboardGroupsByCode(mixed, resolveRegion);

  assert.equal(
    Number(sumOf(mergedMixed).toFixed(6)),
    Number(sumOf(mixed).toFixed(6)),
    "the merged total equals the unmerged total exactly — buildSourceOfSalesDashboard's geo reconciliation guard fails CLOSED on byRegion's sum, so a merge that moved the total would blank the whole geography for scoped viewers",
  );

  // ── What the master cannot adjudicate is deliberately left alone ────────────────────────────
  const labels = mergedMixed.map((row) => row.label);
  assert.equal(
    mergedMixed.length,
    5,
    "AB collapses to one and CA collapses to one, but the two unknown-code groups and the null-code group each stay their own row — 2 merged + 3 untouched",
  );
  assert.deepEqual(
    labels.filter((label) => label === "Unknown One" || label === "Unknown Two").sort(),
    ["Unknown One", "Unknown Two"],
    "two groups sharing code ZZ stay SEPARATE and keep their raw labels — the master does not know ZZ, so nothing proves they are the same place and merging them would fuse genuinely distinct regions",
  );
  assert.ok(
    labels.includes("No Code At All"),
    "a null-code group is never merged into anything — it has no identity to merge on",
  );

  // The EMPTY-STRING code is the shape that actually occurs in production, not null: every
  // unmapped row arrives as code "" with label "" (5 such area rows in 2026-07, one per region,
  // and 29 brick rows). They must each stay their own row — folding them together on a blank code
  // would destroy the per-region split of unmapped value and print one meaningless total.
  //
  // Two independent things protect that, and this asserts the SECOND one specifically. The first
  // is that the three master maps can never hold a blank key (all three build with `if (code …)`),
  // so a real resolver returns null for "" regardless. That alone makes a fixture using
  // `resolveRegion` pass even with the `group.code ?` guard removed — verified, and it is why the
  // resolver below deliberately DOES answer for a blank code: it isolates the guard itself, which
  // is the belt to the master maps' braces.
  const unmappedRows: SourceOfSalesDashboardGroup[] = [
    { ...group("", "", 56_696), key: "||D2", line: "Delta (2)" },
    { ...group("", "", 42_656), key: "||D1", line: "Delta (1)" },
    { ...group("", "", 29_697), key: "||UE", line: "Upper Egypt" },
  ];
  const resolveEvenBlank = (code: string) => ({ label: code === "" ? "Unmapped" : REGION_MASTER.get(code) });
  const unmapped = mergeDashboardGroupsByCode(unmappedRows, resolveEvenBlank);

  assert.equal(
    unmapped.length,
    3,
    "three empty-code unmapped rows stay THREE rows even against a resolver that WOULD name a blank code — an empty string is falsy, so it never becomes an identity. Without that guard every unmapped row in the period collapses into one meaningless total",
  );
  assert.deepEqual(
    unmapped.map((row) => row.line),
    ["Delta (2)", "Delta (1)", "Upper Egypt"],
    "and each keeps its own parent region, which is the only thing that makes an unmapped row actionable",
  );
  assert.deepEqual(
    unmapped.map((row) => row.label),
    ["", "", ""],
    "a blank-code row is never relabelled either — the guard short-circuits before the resolver is consulted at all",
  );

  // A merge keyed on the LABEL rather than the code would silently fuse the two Cairos below
  // (one is really Alex-BHR's, one is really Cairo's). Pin that it does not.
  const twoCairos = mergeDashboardGroupsByCode(
    [group("AB", "Cairo", 2_379), group("CA", "Cairo", 3_348_753)],
    resolveRegion,
  );
  assert.equal(
    twoCairos.length,
    2,
    "two groups whose IMPORT-TIME name is both 'Cairo' but whose codes differ (AB vs CA) stay two rows — identity is the code, never the label",
  );
  assert.deepEqual(
    twoCairos.map((row) => row.label).sort(),
    ["Alex-BHR", "Cairo"],
    "and each is relabelled to ITS OWN master name, so the AB row stops claiming to be Cairo",
  );

  // ── Ordering stays value-desc, the order every SoS table renders in ─────────────────────────
  const values = mergedMixed.map((row) => row.totalValue);
  assert.deepEqual(
    [...values].sort((left, right) => right - left),
    values,
    "merged output is sorted by value descending, matching aggregateDashboardGroups so the tables' order does not change under the fix",
  );

  // ── …and the loader actually routes all three geo dimensions through it ─────────────────────
  // Regions were what the owner saw, but areas were worse (101 rows for 51 areas). A future edit
  // that reverts one dimension and leaves the others would look fixed on the screen that was
  // reported and stay broken on the two that were not.
  const importSource = readSource("../src/lib/sales/monthly-distributor-import.ts");
  for (const dimension of ["byRegion", "byArea", "byBrick"]) {
    assert.match(
      importSource,
      new RegExp(`const ${dimension} = mergeDashboardGroupsByCode\\(dashboard\\.${dimension},`),
      `loadSourceOfSalesDashboard merges ${dimension} by master-resolved code — a plain .map() here relabels without merging, which is precisely the bug`,
    );
  }

  // The pure builder must NOT merge: it has no masters, and tests/ceo-sos-table-row-keys.test.ts
  // depends on it keeping one row per group_key.
  assert.ok(
    !/aggregateDashboardGroups[\s\S]{0,400}mergeDashboardGroupsByCode/.test(importSource),
    "aggregateDashboardGroups still groups on group_key alone — the merge belongs in the loader, where the master tables are actually available",
  );
}
