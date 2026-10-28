import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COMPANY_DIRECT_LABEL, groupClosingCorrections } from "../src/lib/sales/closing-corrections.ts";
import type { ClosingCorrectionRow } from "../src/lib/sales/closing-corrections.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

// A DIRECT ROW WITH NO AREA IS BOOKED BY REGION IN THE CLOSING, SO THE CORRECTIONS PAGE KEYS IT BY
// REGION TOO.
//
// SoS audit, confirmed critical: "Direct rows are booked by AREA on this page but by REGION in the
// closing, inventing a cell that does not exist". The closing never puts a no-area Direct row in an
// area cell: phx_monthly_closing_direct returns it by region and injectDirectIntoMatrix gives each
// region its own "Direct orders (company)" row. `phx_closing_corrections` grouped it by area anyway,
// so every region's no-area Direct money fell into ONE blank-area cell and was netted together.
//
// Measured on production 2026-09-18, 2026-04 Pedia, Lacto Advanced 2:
//   the page     one row, "(no area) ()", -350 units / -66,880.00 EGP
//   the closing  Direct row, region AB    +82 units / +16,280.00 EGP
//                Direct row, region D1   -432 units / -83,160.00 EGP
// A cell the closing does not have, the region carrying the credit unnamed, and the real negative
// understated by 16,280.00 EGP.

const MIGRATIONS_URL = new URL("../supabase/migrations/", import.meta.url);

const LOADER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/closing-corrections.ts", import.meta.url)),
  "utf8",
);
const VIEW_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/sales/closing-corrections-view.tsx", import.meta.url)),
  "utf8",
);

/** The newest migration defining phx_closing_corrections — the one that wins at deploy time. */
function correctionsMigration(): string {
  const names = readdirSync(fileURLToPath(MIGRATIONS_URL))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const defining = names.filter((name) =>
    readFileSync(new URL(name, MIGRATIONS_URL), "utf8").includes("FUNCTION public.phx_closing_corrections"),
  );
  assert.ok(defining.length > 0, "no migration defines phx_closing_corrections");
  return readFileSync(new URL(defining[defining.length - 1]!, MIGRATIONS_URL), "utf8");
}

/** SQL with comments stripped and whitespace collapsed. */
function statementsOf(sql: string): string {
  return stripSqlComments(sql).toLowerCase().replace(/\s+/g, " ");
}

const REGION_KEY = "case when f.is_direct and btrim(coalesce(f.area_code, '')) = '' then upper(btrim(coalesce(f.region_code, ''))) end";

function directRow(regionCode: string, regionName: string, units: number, value: number): ClosingCorrectionRow {
  return {
    kind: "net_negative",
    period: "2026-04",
    otherPeriod: null,
    line: "Pedia",
    distributorCode: "",
    distributorName: "",
    areaCode: "",
    areaName: `${COMPANY_DIRECT_LABEL} · ${regionName}`,
    regionCode,
    productCode: "LA002",
    productName: "Lacto Advanced 2",
    clientName: null,
    units,
    value,
    otherUnits: null,
    otherValue: null,
  };
}

export async function runClosingCorrectionsDirectByRegionTests(): Promise<void> {
  const statements = statementsOf(correctionsMigration());
  const closingCells = statements.slice(statements.indexOf("closing_cells as ("));
  const closingCellsGroup = closingCells.slice(closingCells.indexOf("group by"), closingCells.indexOf(" ) select"));

  // HEADLINE — the closing's cell for a no-area Direct row is its REGION's Direct row, so the cell
  // must be grouped by that region. Without it, AB's +82 and D1's -432 net to one -350 cell that
  // exists nowhere in the closing.
  assert.ok(
    closingCellsGroup.includes(REGION_KEY),
    "the net_negative cell must key a Direct row with no area by its REGION, as the closing books it " +
      `(one "Direct orders (company)" row per region) — otherwise regions net into one invented cell. ` +
      `Found: ${closingCellsGroup.slice(0, 240)}`,
  );
  assert.ok(
    closingCells.includes(`${REGION_KEY} as cell_region`),
    "closing_cells must carry that region out as cell_region",
  );

  // The region travels to the caller right after other_value: on net_negative rows, and on a
  // reversal pair of no-area Direct rows, which is keyed by region the same way (20260918165553). It
  // is NULL on late_return, and on every reversal pair of an ordinary area cell. (other_net_units,
  // added by 20260918175500, follows it as the last column — pinned by
  // tests/closing-corrections-masked-reversals.test.ts.)
  assert.ok(
    /returns table\([^)]*other_value numeric, region_code text[,)]/.test(statements),
    "phx_closing_corrections must return region_code right after other_value",
  );
  const netNegative = statements.slice(statements.indexOf("select 'net_negative'::text"));
  assert.ok(
    /null, null, c\.cell_region(, null::numeric)? from closing_cells c/.test(netNegative),
    "the net_negative branch must return the cell's region",
  );
  assert.ok(
    /else neg\.cell_value end\)::numeric, 2\), pos\.cell_region, neg\.cell_units from cells pos/.test(statements),
    "reversal_pair must return its cells' region — set only for a no-area Direct pair, NULL for an area cell",
  );
  assert.ok(
    statements.includes("neg.cell_region is not distinct from pos.cell_region"),
    "a reversal pair must never join two regions' no-area Direct rows",
  );
  assert.ok(
    /origin\.origin_units, null, null::text(, null::numeric)? from \(/.test(statements),
    "late_return must return NULL for region_code — it stays per distributor",
  );

  // A Direct row that CARRIES an area still folds into that area's cell, exactly as the closing
  // does: the region key is gated on a blank area, and the area stays in the grouping.
  assert.ok(closingCellsGroup.startsWith("group by f.period, f.official_line, f.area_code,"));

  // Replacing the function drops its ACL, so the migration must restate it.
  assert.ok(
    statements.includes("grant execute on function public.phx_closing_corrections(text) to service_role"),
    "the service role must keep EXECUTE after the drop and recreate",
  );
  assert.ok(
    statements.includes("revoke execute on function public.phx_closing_corrections(text) from public, anon, authenticated"),
    "the function must stay closed to public, anon and authenticated",
  );
  // PARALLEL SAFE again since 20260918175500: the take-back is read from the rollup, and nothing
  // here calls the parallel-unsafe phx_sos_rows_attributed any more.
  assert.ok(statements.includes("stable parallel safe security definer"), "function attributes preserved");

  // Two regions' Direct rows are two cells and two situations, never one.
  const grouped = groupClosingCorrections(
    [directRow("AB", "Alex-BHR", -82, -16_280), directRow("D1", "Delta (1)", -432, -83_160)],
    "2026-04",
  );
  assert.equal(grouped.netNegatives.length, 2, "one row per region's Direct row");
  assert.equal(grouped.situationCount, 2, "two regions' Direct rows are two situations, not one");
  assert.deepEqual(
    grouped.netNegatives.map((cell) => cell.value),
    [-83_160, -16_280],
    "each region keeps its own figure, biggest distortion first",
  );
  const [worst] = grouped.netNegatives;
  assert.equal(worst!.areaName, `${COMPANY_DIRECT_LABEL} · Delta (1)`);
  assert.ok(
    worst!.impact.includes(`"${COMPANY_DIRECT_LABEL}" row`) && !worst!.impact.includes("every distributor"),
    `a region's Direct row must be explained as the closing's own Direct row. Got: ${worst!.impact}`,
  );

  // An ordinary area cell is unchanged.
  const areaCell = groupClosingCorrections(
    [{ ...directRow("", "", -13, -2_659.95), areaCode: "D21", areaName: "Dakahlia 1", regionCode: null, line: "Anti Infective" }],
    "2026-07",
  );
  assert.ok(areaCell.netNegatives[0]!.impact.includes("every distributor"));

  // The loader names the row the way the closing does, and asks for the region.
  assert.ok(LOADER_SOURCE.includes('"region_code"'), "the loader must read region_code from the RPC");
  assert.ok(
    LOADER_SOURCE.includes("`${COMPANY_DIRECT_LABEL} · ${regionName}`"),
    "a region's Direct row is named with the closing's Direct label and the region's name",
  );
  assert.equal(COMPANY_DIRECT_LABEL, "Direct orders (company)");

  // The view never prints an empty "()" after a name: "(no area) ()" was the audit's evidence.
  assert.ok(
    !/\$\{\w+\.areaName\} \(\$\{\w+\.areaCode\}\)/.test(VIEW_SOURCE),
    "the view must print the area through areaLabel, never `${areaName} (${areaCode})` directly",
  );
  assert.equal((VIEW_SOURCE.match(/areaLabel\(\w+\.areaName, \w+\.areaCode\)/g) ?? []).length, 3);
  // Names, never codes: the area prints as its name alone (docs/tables-said-once-fit.md rule 4).
  assert.ok(VIEW_SOURCE.includes("function areaLabel(areaName: string, _areaCode: string): string {\n  return areaName;"));
}
