import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildPortalWeeklyFieldForce,
  selectFieldForceSeats,
  type FieldForceSeatRow,
  type PortalWeeklyFieldForce,
} from "../src/lib/sales/weekly/portal-weekly-field-force.ts";
import {
  buildWeeklyProductUnitsMatrix,
  selectWeeklyProductUnitsMonths,
  weeklyProductUnitsAxis,
  WEEKLY_PRODUCT_UNITS_MAX_MONTHS,
  WEEKLY_PRODUCT_UNITS_MONTHS,
} from "../src/lib/sales/weekly/portal-weekly-product-units.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// Weekly Sales — the PRODUCTS BY MONTH tab, which the owner asked for as "the same per-product units
// tab" the monthly Performance Review has. Five things about it are load-bearing and none of them is
// visible on screen when it breaks:
//
//   1. ONE SHARED PRODUCT AXIS. Block N must be the same product in every month. The grid is built
//      from one field-force build PER MONTH, and each build orders a rep's own products by value — so
//      without an axis handed in from outside, month 2's third block would be a different product
//      from month 1's third block and every growth figure would compare two different medicines.
//   2. NO ROW TOTAL, EVER. A row spans products and units of different products are never added
//      (owner rule). Each block is one product code, which is what makes its own months addable.
//   3. A MONTH THAT WAS NEVER UPLOADED IS NOT A ZERO. A null means no sheet; a 0 means the sheet came
//      and this person sold none of that product. A subtotal over nulls stays null.
//   4. MONEY THAT REACHED NO AREA IS REPORTED. It rides its own LINE's bucket row, never folded into
//      a region that did not earn it and never dropped — dropping it makes the rows add to less than
//      the line really sold, which is the one discrepancy a reader cannot explain.
//   5. THE LOAD IS STRICTER THAN THE FIELD FORCE TAB'S. Every weekly report sets excludeUnmapped
//      (owner rule), and it matters most here: an unmapped SKU double-counts against the real product
//      it belongs to, and this grid is nothing but per-product unit counts.

const SEATS: FieldForceSeatRow[] = [
  {
    seat_id: "SEAT-CNS-DM-AB",
    seat_tier: "DM",
    line_code: "cns",
    line_name: "CNS",
    region_code: "AB",
    region_name: "Alex-BHR",
    occupant_hr_id: "b-900",
    is_vacant: false,
  },
  {
    seat_id: "SEAT-CNS-REP-AB1",
    seat_tier: "REP",
    line_code: "cns",
    line_name: "CNS",
    region_code: "AB",
    region_name: "Alex-BHR",
    area_code: "AB1",
    area_name: "Alex East",
    occupant_hr_id: "B-135",
    is_vacant: false,
    parent_seat_id: "SEAT-CNS-DM-AB",
  },
  {
    seat_id: "SEAT-CNS-REP-AB2",
    seat_tier: "REP",
    line_code: "cns",
    line_name: "CNS",
    region_code: "AB",
    region_name: "Alex-BHR",
    area_code: "AB2",
    area_name: "Alex Center",
    occupant_hr_id: null,
    is_vacant: true,
    parent_seat_id: "SEAT-CNS-DM-AB",
  },
  // Cairo on the same line, so the region ORDER is testable: Cairo reads before Alex-BHR in the
  // Performance Review palette, and this grid shares that order so one region is one place on
  // every Phoenix screen.
  {
    seat_id: "SEAT-CNS-REP-CA1",
    seat_tier: "REP",
    line_code: "cns",
    line_name: "CNS",
    region_code: "CA",
    region_name: "Cairo",
    area_code: "CA1",
    area_name: "Cairo East",
    occupant_hr_id: "B-140",
    is_vacant: false,
  },
  // The same AREA CODE on another line is another person — the reason a second line is in this
  // fixture at all, and the reason a region subtotal may never span lines.
  {
    seat_id: "SEAT-PEDIA-REP-AB1",
    seat_tier: "REP",
    line_code: "pedia",
    line_name: "Pedia",
    region_code: "AB",
    region_name: "Alex-BHR",
    area_code: "AB1",
    area_name: "Alex East",
    occupant_hr_id: "P-200",
    is_vacant: false,
  },
];

const NAMES: Record<string, string> = {
  "b-135": "Mahmoud Fathy",
  "b-140": "Hossam Nabil",
  "p-200": "Nourhan Adel",
  "b-900": "Karim Selim",
};
const nameOf = (hrId: string | null) => (hrId ? (NAMES[hrId] ?? null) : null);

function factRow(overrides: Partial<WeeklyFactExportRow>): WeeklyFactExportRow {
  return {
    distributorCode: "POS",
    distributorName: "POS",
    productCode: "P1",
    productName: "Tebofortin 40mg",
    line: "CNS",
    regionCode: "AB",
    regionName: "Alex-BHR",
    areaCode: null,
    branchCode: "BR1",
    branchName: "Alex Branch",
    cycleMonth: "2026-07-01",
    weekNumber: 1,
    weekStart: "2026-07-05",
    batchId: "batch-1",
    family: "Tebofortin",
    salesValue: 0,
    salesUnits: 0,
    stockUnits: 0,
    ...overrides,
  };
}

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The cell for one row key and one product code, across the months. */
function cellsOf(
  matrix: ReturnType<typeof buildWeeklyProductUnitsMatrix>,
  rowKey: string,
  productCode: string,
): Array<number | null> {
  const row = matrix.rows.find((candidate) => candidate.key === rowKey);
  assert.ok(row, `row ${rowKey} is on the grid`);
  const index = matrix.columns.findIndex((column) => column.key === productCode);
  assert.ok(index >= 0, `product ${productCode} has a block`);
  return row.units[index] ?? [];
}

export function runWeeklyProductUnitsTests() {
  const seatIndex = selectFieldForceSeats(SEATS, nameOf);

  // ── 1. the window ──────────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    selectWeeklyProductUnitsMonths(
      ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"],
      3,
    ),
    ["2026-07-01", "2026-08-01", "2026-09-01"],
    "the window is the NEWEST months, oldest first — the order every block reads left to right",
  );
  assert.equal(
    selectWeeklyProductUnitsMonths(
      ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"],
      99,
    ).length,
    WEEKLY_PRODUCT_UNITS_MAX_MONTHS,
    "a caller cannot ask for more months than the cap, however large a number it sends",
  );
  assert.deepEqual(
    selectWeeklyProductUnitsMonths(["2026-07", "not-a-month", "2026-08-01", ""], 3),
    ["2026-08-01"],
    "anything that is not a first-of-month code is refused rather than read as a month",
  );
  assert.deepEqual(
    selectWeeklyProductUnitsMonths(["2026-08-01", "2026-08-01", "2026-07-01"], 3),
    ["2026-07-01", "2026-08-01"],
    "a month named twice is one column",
  );
  assert.equal(WEEKLY_PRODUCT_UNITS_MONTHS, 3, "three months by default — the window the owner asked for");

  // ── 2. the axis ────────────────────────────────────────────────────────────────────────────
  const axis = weeklyProductUnitsAxis([
    factRow({ productCode: "P1", productName: "Tebofortin 40mg", salesValue: 100, salesUnits: 1 }),
    factRow({ productCode: "P2", productName: "Conviban 10mg", salesValue: 900, salesUnits: 2 }),
    // Real units, no price yet. It still earns a block — the Product Master may simply be behind.
    factRow({ productCode: "P3", productName: "Royanoxicam", salesValue: 0, salesUnits: 40 }),
    // Neither units nor value: nothing happened, so it is not a column.
    factRow({ productCode: "P4", productName: "Satoslim", salesValue: 0, salesUnits: 0 }),
    factRow({ productCode: "   ", productName: "no code at all", salesValue: 50, salesUnits: 5 }),
  ]);
  assert.deepEqual(
    axis.map((entry) => entry.code),
    ["P2", "P1", "P3"],
    "the axis is ordered by VALUE, biggest first — ordering it by units would itself compare units of different products",
  );
  assert.ok(
    !axis.some((entry) => entry.code === "P4"),
    "a product that moved neither units nor money earns no block",
  );
  assert.ok(!axis.some((entry) => entry.code === ""), "a row with no product code is never a column");

  // ── 3. the grid, three months, two lines ───────────────────────────────────────────────────
  // July: both lines sell. August: the CNS rep's Tebofortin falls, Conviban appears, Cairo sells
  // nothing of either, and the residue lands again. September: no sheet at all.
  const sharedAxis = [
    { code: "P1", name: "Tebofortin 40mg", value: 3_000 },
    { code: "P2", name: "Conviban 10mg", value: 1_200 },
  ];
  const buildMonth = (rows: WeeklyFactExportRow[]): PortalWeeklyFieldForce =>
    buildPortalWeeklyFieldForce({
      rows,
      areaSplit: null,
      seatIndex,
      productAxis: sharedAxis.map((product) => ({ code: product.code, name: product.name })),
    });

  const july = buildMonth([
    factRow({ areaCode: "AB1", salesValue: 2_000, salesUnits: 20 }),
    factRow({ areaCode: "AB2", salesValue: 400, salesUnits: 4 }),
    factRow({ areaCode: "CA1", regionCode: "CA", regionName: "Cairo", salesValue: 600, salesUnits: 6 }),
    factRow({
      areaCode: "AB1",
      line: "Pedia",
      productCode: "P2",
      productName: "Conviban 10mg",
      family: "Conviban",
      salesValue: 1_000,
      salesUnits: 50,
    }),
    // An area no line seats: reaches no rep, and must still be reported under its line's bucket.
    factRow({ areaCode: "ZZ9", salesValue: 90, salesUnits: 9 }),
  ]);
  const august = buildMonth([
    factRow({ cycleMonth: "2026-08-01", areaCode: "AB1", salesValue: 1_000, salesUnits: 10 }),
    factRow({
      cycleMonth: "2026-08-01",
      areaCode: "AB1",
      productCode: "P2",
      productName: "Conviban 10mg",
      family: "Conviban",
      salesValue: 200,
      salesUnits: 3,
    }),
    factRow({ cycleMonth: "2026-08-01", areaCode: "AB2", salesValue: 200, salesUnits: 2 }),
    factRow({
      cycleMonth: "2026-08-01",
      areaCode: "CA1",
      regionCode: "CA",
      regionName: "Cairo",
      salesValue: 300,
      salesUnits: 3,
    }),
    factRow({
      cycleMonth: "2026-08-01",
      areaCode: "AB1",
      line: "Pedia",
      productCode: "P2",
      productName: "Conviban 10mg",
      family: "Conviban",
      salesValue: 500,
      salesUnits: 25,
    }),
  ]);

  const matrix = buildWeeklyProductUnitsMatrix({
    perMonth: [
      { cycleMonth: "2026-07-01", grid: july },
      { cycleMonth: "2026-08-01", grid: august },
      // Nobody has uploaded September. It keeps its column, and the column is not zeros.
      { cycleMonth: "2026-09-01", grid: null },
    ],
    productAxis: sharedAxis,
    generatedAt: "2026-10-09T12:00:00.000Z",
  });

  assert.deepEqual(matrix.months, ["2026-07-01", "2026-08-01", "2026-09-01"], "the months are the window, in order");
  assert.deepEqual(matrix.emptyMonths, ["2026-09-01"], "a month with no sheet is NAMED, so the screen can say so");
  assert.deepEqual(
    matrix.columns.map((column) => column.key),
    ["P1", "P2"],
    "the blocks are the shared axis, in its order — block N is the same product in every month",
  );
  assert.ok(
    matrix.columns.every((column) => column.unitsAreAddable),
    "every block is one product code, so every block's units are a real quantity",
  );

  // RULE 2: no row total. Not "it is zero" — the field does not exist.
  for (const row of matrix.rows) {
    const keys = Object.keys(row);
    assert.ok(
      !keys.some((key) => /^(total|totalUnits|rowTotal|units[Tt]otal)$/.test(key)),
      `row ${row.key} carries no row total — units of different products are never added`,
    );
  }

  // RULE 1 and 3: the CNS rep's own blocks.
  const repKey = july.reps.find((rep) => rep.repName === "Mahmoud Fathy")?.key;
  assert.ok(repKey, "the CNS Alex East rep is on the July grid");
  assert.deepEqual(
    cellsOf(matrix, repKey, "P1"),
    [20, 10, null],
    "his Tebofortin reads July 20, August 10, and September as NOT UPLOADED — never as a zero",
  );
  assert.deepEqual(
    cellsOf(matrix, repKey, "P2"),
    [0, 3, null],
    "a product he did NOT sell in a month the sheet arrived for reads 0 — the sheet came, the product did not move",
  );
  const repRow = matrix.rows.find((row) => row.key === repKey);
  assert.equal(repRow?.repName, "Mahmoud Fathy", "the person is named, never an HR id");
  assert.equal(repRow?.managerName, "Karim Selim", "his district manager rides the row, for an NSM reading it");
  assert.ok(
    Math.abs((repRow?.growth[0] ?? 0) - -0.5) < 1e-9,
    "growth is the newest REAL month over the one before it: 10 against 20 is −50%, and September's gap is skipped",
  );

  // The vacant seat still sells and still has a row.
  const vacant = matrix.rows.find((row) => row.kind === "vacant");
  assert.ok(vacant, "a seat nobody occupies keeps its row — the area exists and can still sell");
  assert.equal(vacant?.repName, null, "and it shows no name rather than an HR id");

  // RULE 4: the residue.
  const residue = matrix.rows.filter((row) => row.kind === "unattributed");
  assert.equal(residue.length, 1, "money that reached no area is reported, under exactly one bucket row per line");
  assert.equal(residue[0]?.lineName, "CNS", "the bucket belongs to the LINE whose money it is");
  assert.equal(residue[0]?.regionName, null, "and to no region, because no region earned it");
  assert.deepEqual(cellsOf(matrix, residue[0]!.key, "P1"), [9, 0, null], "its own months read like anyone else's");

  // RULE 1 again, on the subtotals: a region total adds its own areas, down one product's column.
  const alexCns = matrix.rows.find((row) => row.key === "region:cns|AB");
  assert.ok(alexCns, "the CNS Alex-BHR region has a subtotal row");
  assert.deepEqual(
    cellsOf(matrix, "region:cns|AB", "P1"),
    [24, 12, null],
    "Alex East plus Alex Center, month by month — and still null where no sheet arrived",
  );
  const pediaAlex = matrix.rows.find((row) => row.key === "region:pedia|AB");
  assert.ok(pediaAlex, "the SAME region on the other line has its OWN subtotal");
  assert.deepEqual(
    cellsOf(matrix, "region:pedia|AB", "P2"),
    [50, 25, null],
    "a region subtotal never spans lines — the Pedia rep's Conviban is his line's, not CNS's",
  );
  assert.deepEqual(
    cellsOf(matrix, "region:pedia|AB", "P1"),
    [0, 0, null],
    "and the other line's product reads 0 on it, not the CNS figure",
  );

  // A line total adds its regions AND its residue.
  assert.deepEqual(
    cellsOf(matrix, "line:cns", "P1"),
    [39, 15, null],
    "CNS = Alex-BHR (24/12) + Cairo (6/3) + the residue (9/0)",
  );
  assert.deepEqual(cellsOf(matrix, "grandTotal", "P2"), [50, 28, null], "the national total adds the lines");
  assert.equal(
    matrix.rows.filter((row) => row.kind === "grandTotal").length,
    1,
    "exactly one grand total, and only because two lines are on screen",
  );

  // Region ORDER: Cairo before Alex-BHR, as the Performance Review paints them.
  const cnsRegionOrder = matrix.rows
    .filter((row) => row.kind === "regionSubtotal" && row.lineCode === "cns")
    .map((row) => row.regionCode);
  assert.deepEqual(
    cnsRegionOrder,
    ["CA", "AB"],
    "regions read in the Performance Review's own order, so one region is one place on every Phoenix screen",
  );

  // A single line on screen prints no grand total — it would be the line total twice.
  const oneLine = buildWeeklyProductUnitsMatrix({
    perMonth: [{ cycleMonth: "2026-07-01", grid: buildMonth([factRow({ areaCode: "AB1", salesValue: 10, salesUnits: 1 })]) }],
    productAxis: sharedAxis,
  });
  assert.equal(
    oneLine.rows.filter((row) => row.kind === "grandTotal").length,
    0,
    "with one line there is no grand total — a second, identical figure reads as a disagreeing one",
  );

  // An empty window is a grid with nothing in it, never a throw.
  const empty = buildWeeklyProductUnitsMatrix({ perMonth: [], productAxis: [] });
  assert.deepEqual(empty.rows, [], "no months is an empty grid");
  assert.deepEqual(empty.columns, [], "and no blocks");

  // The honesty figures the screen prints come from the builds themselves, not from a second count.
  assert.ok(matrix.totals.value > 0, "the window's value is carried, for the exact/allocated sentence");
  assert.equal(
    matrix.totals.exactValue + matrix.totals.allocatedValue + matrix.totals.unattributedValue,
    matrix.totals.value,
    "exact + allocated + unattributed is the whole of it, so the screen's percentage cannot be a fiction",
  );

  // ── 4. the load: stricter than the Field Force tab's, and one engine ───────────────────────
  const service = readSource("../src/lib/sales/weekly/portal-weekly-product-units.ts");
  assert.match(
    service,
    /excludeUnmapped: true/,
    "every weekly report sets excludeUnmapped (owner rule) — and an unmapped SKU would double-count against the real product",
  );
  assert.match(
    service,
    /factRowsFullPrecision: true/,
    "the cells are allocated shares, so the rows arrive unrounded — rounding each one loses a visible unit across a month",
  );
  assert.match(
    service,
    /narrowRowsToCycleMonths: months/,
    "the fetch itself is narrowed to the window, which is allowed because this loader discards the option lists",
  );
  assert.match(
    service,
    /buildPortalWeeklyFieldForce\(\{/,
    "the months are built through the SAME engine the Field Force tab uses, so the two cannot drift apart",
  );
  assert.match(
    service,
    /productAxis: productAxis\.map\(\(product\) => \(\{ code: product\.code, name: product\.name \}\)\)/,
    "and every month is built with the ONE shared axis — the whole reason block N is the same product in each",
  );
  assert.match(
    service,
    /resolveWeeklyAccessScope\(ctx\)/,
    "the viewer's scope resolves from the session, never from a query parameter",
  );
  assert.match(
    service,
    /mayLiftWeeklyGeography\(accessScope, ownAreaKeys\)/,
    "a district or regional manager's grid follows his own areas, as every figure on his screen does",
  );
  assert.match(
    service,
    /if \(accessScope\.tier === "none"\) return null;/,
    "a viewer with no weekly access gets nothing, not an empty grid that looks like a quiet month",
  );

  const route = readSource("../app/api/employee-portals/weekly-sales/product-units/route.ts");
  assert.match(route, /assertPermission\(access, "sales", "read"\)/, "the route enforces the permission server-side");
  assert.match(
    route,
    /if \(!mayReadManagersWeeklySales\(access\.role\)\)/,
    "and the same role gate the dashboard feed uses — the one shared predicate (owner, 2026-10-20)",
  );
  assert.doesNotMatch(route, /accessScope|regionCodes|lineCodes/, "the query carries the month window and nothing that could widen scope");

  // ── 5. the screen: one declared scroll box, shared ─────────────────────────────────────────
  const view = readSource("../src/components/sales/weekly/weekly-product-units-view.tsx");
  assert.match(
    view,
    /import \{ MatrixScroller \} from "@\/components\/ui\/matrix-scroller";/,
    "the grid uses the ONE declared matrix scroller",
  );
  assert.doesNotMatch(
    view,
    /overflow-(x-)?(auto|scroll)/,
    "and opens no scroll box of its own — the fits-the-screen ratchet counts the shared one once",
  );
  assert.doesNotMatch(view, /rounded/, "the square-edge golden rule: nothing on this tab draws a round corner");
  assert.doesNotMatch(view, /truncate|text-ellipsis|line-clamp-/, "and nothing is cut with an ellipsis — text wraps");
  assert.match(view, /WEEKLY_UNITS_UNDER_ONE/, "a positive share under one unit reads \"<1\", never a 0 beside the money it earned");

  const workspace = readSource("../src/components/sales/closing-performance-review-workspace.tsx");
  assert.match(
    workspace,
    /import \{ MatrixScroller \} from "@\/components\/ui\/matrix-scroller";/,
    "the monthly review imports the same one rather than declaring a second",
  );
  assert.doesNotMatch(
    workspace,
    /function MatrixScroller/,
    "there is exactly ONE MatrixScroller in the repository, so the permission is reasoned about in one place",
  );

  const dashboard = readSource("../src/components/sales/weekly/portal-weekly-dashboard-impl.tsx");
  assert.match(dashboard, /key: "products", label: "Products by Month"/, "the tab is on the Weekly Sales tab bar");
  assert.match(
    dashboard,
    /if \(next === "products"\) setProductsOpened\(true\);/,
    "it loads on its FIRST opening and then stays mounted, so several months of row grain are not re-read on a tab switch",
  );
  assert.match(
    dashboard,
    /active=\{activeTab === "products" && !isEmpty\}/,
    "and it fetches only while it is the open tab",
  );
  assert.match(
    dashboard,
    /hostFilterCount=\{activeFilterCount\}/,
    "the page's filter count reaches the tab, which does NOT follow that bar and must say so rather than letting a filtered reader read these rows as his region's",
  );
  assert.match(
    view,
    /do not\s+narrow this grid/,
    "and the tab says it in words, exactly when a filter is held",
  );
}
