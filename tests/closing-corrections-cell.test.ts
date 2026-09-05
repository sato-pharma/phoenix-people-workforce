import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { groupClosingCorrections } from "../src/lib/sales/closing-corrections.ts";

// "RETURNS BIGGER THAN THE MONTH'S SALES" MUST BE THE CLOSING'S CELL, NOT ONE DISTRIBUTOR'S SHARE.
//
// SoS audit, confirmed critical. The page tells the Super Admin — the only role that can open it —
// that a negative he can see in the closing is real rather than a bug. It did that by grouping
// `phx_closing_corrections`'s cells by distributor as well as area and product, while the closing
// (phx_monthly_closing_matrix) groups by area and product ONLY. Each row was therefore one
// distributor's net position presented as the cell.
//
// Measured on production 2026-09-05, every row the page flagged for 2026-05..07:
//   CELL IS ACTUALLY POSITIVE (the page invented a negative):
//     CA2/TE003 -15 u -> +1,084 u | CA1/TE003 -20 u -> +346 u | AB4/RO001 -34 u -> +31 u
//   NEGATIVE BUT THE WRONG SIZE:
//     D21/SA001 -179 u -> -13 u (13x) | D21/RO001 -170 -> -151 | CA4/CO002 -80 -> -76 |
//     UE5/TE001 -31 -> -29
//   Correct, and only because one distributor sold that cell: AB3/LA002, GZ1/LA002, UE9/LA001
// 7 of 10 rows contradicted the closing, three in SIGN.
//
// This test pins the shape of the fix, because the natural "tidy-up" — reinstating the distributor
// so the table has a name in every column — reintroduces the defect exactly.

const MIGRATIONS_URL = new URL("../supabase/migrations/", import.meta.url);

const VIEW_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/sales/closing-corrections-view.tsx", import.meta.url)),
  "utf8",
);

const LOADER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/closing-corrections.ts", import.meta.url)),
  "utf8",
);

/** The newest migration defining phx_closing_corrections, found by content, not by filename. */
function correctionsMigration(): string {
  const names = readdirSync(fileURLToPath(MIGRATIONS_URL))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const defining = names.filter((name) =>
    readFileSync(new URL(name, MIGRATIONS_URL), "utf8").includes(
      "FUNCTION public.phx_closing_corrections",
    ),
  );
  assert.ok(defining.length > 0, "no migration defines phx_closing_corrections");
  // The LAST one wins at deploy time, so that is the one whose shape matters.
  return readFileSync(new URL(defining[defining.length - 1]!, MIGRATIONS_URL), "utf8");
}

/** SQL with comment lines stripped — this migration documents the old bug at length. */
function statementsOf(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .toLowerCase();
}

export async function runClosingCorrectionsCellTests(): Promise<void> {
  const statements = statementsOf(correctionsMigration());

  // ── 1. the net_negative source groups WITHOUT the distributor ──────────────────────────────
  const closingCells = statements.slice(statements.indexOf("closing_cells as ("));
  assert.ok(
    statements.includes("closing_cells as ("),
    "the migration must define a distributor-agnostic cell source for net_negative",
  );
  const closingCellsGroupBy = closingCells.slice(closingCells.indexOf("group by"));
  const closingCellsGroup = closingCellsGroupBy.slice(0, closingCellsGroupBy.indexOf("\n)"));
  assert.ok(
    !closingCellsGroup.includes("distributor"),
    "THE WHOLE DEFECT: the net_negative cell must NOT group by distributor — the closing groups " +
      `by area and product only. Found: ${closingCellsGroup.trim().slice(0, 160)}`,
  );
  for (const column of ["f.area_code", "f.product_code"]) {
    assert.ok(
      closingCellsGroup.includes(column),
      `the closing cell must group by ${column}, matching phx_monthly_closing_matrix`,
    );
  }

  // ── 2. net_negative reads that source and reports NO distributor ───────────────────────────
  const netNegativeSelect = statements.slice(statements.indexOf("'net_negative'::text"));
  const netNegativeBranch = netNegativeSelect.slice(0, netNegativeSelect.indexOf("union all") + 1 || undefined);
  assert.ok(
    /from\s+closing_cells/.test(netNegativeBranch),
    "the net_negative branch must select from closing_cells, not the per-distributor cells CTE",
  );
  assert.ok(
    /'net_negative'::text[^;]*?null::text/.test(netNegativeBranch),
    "net_negative must report distributor_code as NULL — a cell summed over several distributors " +
      "has no single distributor, and naming one is precisely what made the page contradict the closing",
  );

  // ── 3. the other two kinds KEEP the distributor, which is correct, not an oversight ─────────
  // A reversal pair is one distributor posting then retracting; netting across distributors would
  // erase the pattern. A late return is traced by client code, which is unique only per distributor.
  assert.ok(
    /group by f\.period, f\.official_line, b\.distributor_code/.test(statements),
    "the per-distributor cells CTE must survive — reversal_pair depends on it",
  );
  assert.ok(
    /group by b\.period, r\.official_line, b\.distributor_code/.test(statements),
    "late_return must stay grouped per distributor: client codes are unique only per distributor, " +
      "so dropping it would merge different customers",
  );

  // ── 4. the model and the table carry no distributor for this section ────────────────────────
  const typeStart = LOADER_SOURCE.indexOf("export type NetNegativeCell = {");
  assert.ok(typeStart > 0, "expected NetNegativeCell to still exist");
  const typeBody = LOADER_SOURCE.slice(typeStart, LOADER_SOURCE.indexOf("};", typeStart));
  assert.ok(
    !typeBody.includes("distributorName"),
    "NetNegativeCell must not carry distributorName — the row is the whole cell",
  );

  const netNegativeTable = VIEW_SOURCE.slice(VIEW_SOURCE.indexOf("data.netNegatives.map"));
  const columnsBefore = VIEW_SOURCE.slice(0, VIEW_SOURCE.indexOf("data.netNegatives.map"));
  const lastColumns = columnsBefore.lastIndexOf("columns={[");
  const columnList = columnsBefore.slice(lastColumns, columnsBefore.indexOf("]}", lastColumns));
  assert.ok(
    !columnList.includes("Distributor"),
    `the net-negative table must not have a Distributor column. Found: ${columnList.slice(0, 160)}`,
  );
  assert.ok(
    !netNegativeTable.slice(0, 400).includes("distributorName"),
    "the net-negative rows must not render a distributor name",
  );

  // ── 5. the sentence says what the number is ────────────────────────────────────────────────
  const grouped = groupClosingCorrections(
    [
      {
        kind: "net_negative",
        period: "2026-07",
        otherPeriod: null,
        line: "Anti Infective",
        distributorCode: "",
        distributorName: "",
        areaCode: "D21",
        areaName: "Damietta",
        productCode: "SA001",
        productName: "Saginko",
        clientName: null,
        units: -13,
        value: -2660,
        otherUnits: null,
        otherValue: null,
      },
    ],
    "2026-07",
  );
  assert.equal(grouped.netNegatives.length, 1);
  const [cell] = grouped.netNegatives;
  assert.ok(
    cell!.impact.toLowerCase().includes("every distributor"),
    `the sentence must say the figure spans every distributor, so the reader can reconcile it ` +
      `against the closing. Got: ${cell!.impact}`,
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(cell, "distributorName"),
    "a grouped net-negative row must not carry a distributor name at all",
  );
}
