import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decumulateProductNet } from "../src/lib/sales/weekly/decumulate.ts";
import { summarizeWeekly } from "../src/lib/sales/weekly/parser.ts";
import type { WeeklyParsedRow, WeeklyThisWeekOnly } from "../src/lib/sales/weekly/types.ts";
import { weeklyUploadThisWeekUnits, weeklyUploadUnitScope } from "../src/lib/sales/weekly/unit-totals.ts";

// THE UPLOAD SCREEN'S "THIS WEEK ONLY" IS ONE PRODUCT'S FIGURE (owner, 2026-09-19).
//
// Distributor sheets are cumulative within a month, so the green "This week only" panel subtracts the
// previous sheet from this one. It did that with the previous sheet's stored HEADER, which adds every
// product it carried, so on a sheet of several products the panel had no real figure and held a dash —
// units of different products are never added (owner rule, 2026-08-27). The panel now shows the product
// picked under "Units for" (the tiles' own pick): its cumulative here minus its own cumulative on the
// previous sheet, read from that sheet's stored rows.

function row(overrides: Partial<WeeklyParsedRow>): WeeklyParsedRow {
  return {
    rowNumber: 2,
    weekStart: "2026-09-18",
    distributorCode: "PS",
    distributorName: "PS",
    regionCode: "D1",
    regionName: "Delta (1)",
    areaCode: null,
    branchCode: "Key Acc.W Banha",
    branchName: "Key Acc.W Banha",
    itemCode: "37804",
    productCode: "SA001",
    productName: "Saginko",
    officialLine: "CNS",
    salesQty: 0,
    returnQty: 0,
    netQty: 0,
    bonusQty: 0,
    salesValue: 0,
    stockQty: 0,
    validationState: "valid",
    validationIssues: [],
    rawRow: {},
    ...overrides,
  };
}

function sheet(weekStart: string, rows: WeeklyParsedRow[]) {
  return summarizeWeekly({
    rows,
    distributor: { code: "PS", name: "PS" },
    fileName: "PS.xlsx",
    sheetName: "Sheet1",
    weekStart,
    blockingReasons: [],
  });
}

const cells = (
  weekStart: string,
  lines: Array<[productCode: string, productName: string, branch: string, netQty: number]>,
) =>
  lines.map(([productCode, productName, branch, netQty]) =>
    row({ weekStart, productCode, productName, branchCode: branch, branchName: branch, salesQty: netQty, netQty, salesValue: netQty * 100 }),
  );

/** The rows the service stores for a sheet, read back the way loadPriorSheetProductNet reads them. */
const storedRows = (rows: WeeklyParsedRow[]) => rows.map((entry) => ({ productCode: entry.productCode || entry.productName, netQty: entry.netQty }));

/** The slice of a source file that starts at `from` and stops before `to`. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} is found`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `${to} follows it`);
  return source.slice(start, end);
}

export async function runWeeklyThisWeekPerProductTests() {
  // Week 2 of a month, from a sheet that holds two products. Week 1 held the same two products, Saginko at
  // two branches, and every figure on week 2 is the month-to-date total, so it contains week 1.
  const week1Rows = cells("2026-09-04", [
    ["SA001", "Saginko", "Banha", 200],
    ["SA001", "Saginko", "Tanta", 100],
    ["SS001", "Satoslim", "Banha", 10],
  ]);
  const week2Rows = cells("2026-09-11", [
    ["SA001", "Saginko", "Banha", 260],
    ["SA001", "Saginko", "Tanta", 140],
    ["SS001", "Satoslim", "Banha", 34],
  ]);
  const week1 = sheet("2026-09-04", week1Rows);
  const week2 = sheet("2026-09-11", week2Rows);
  const own = (products: { productCode: string; netQty: number }[], code: string) => products.find((entry) => entry.productCode === code)?.netQty;

  // ── 1. The per-product subtraction: each product against its OWN previous cumulative ─────────────
  {
    const thisWeek = decumulateProductNet(
      week2.byProduct.map((product) => ({ productCode: product.productCode, netQty: product.netQty })),
      storedRows(week1Rows),
    );
    assert.equal(own(thisWeek, "SA001"), 100, "Saginko: 400 cumulative now, 300 on the previous sheet — 100 this week");
    assert.equal(own(thisWeek, "SS001"), 24, "Satoslim: 34 now, 10 before — 24 this week, none of Saginko's units in it");
    assert.equal(thisWeek.length, 2, "one figure per product on this sheet, never a combined one");

    // Both sheets carry the same products, so the per-product figures agree with the sheet-level
    // subtraction the panel always did. The sum below is a check on the test's own numbers, never a figure
    // the screen prints.
    const sheetLevel = week2.totals.netQty - week1.totals.netQty;
    assert.equal(
      thisWeek.reduce((sum, entry) => sum + entry.netQty, 0),
      sheetLevel,
      "read against the same products, the per-product weeks add up to the sheet-level figure",
    );
    assert.notEqual(own(thisWeek, "SA001"), sheetLevel, "and no product's figure IS the sheet-level one");
  }

  // ── 2. Nothing to subtract: the first sheet of a month, or a distributor that does not restate ────
  {
    const current = week2.byProduct.map((product) => ({ productCode: product.productCode, netQty: product.netQty }));
    assert.deepEqual(
      decumulateProductNet(current, null),
      current,
      "with no previous sheet each product's own cumulative IS its week",
    );
    assert.deepEqual(
      decumulateProductNet(current, []),
      current,
      "a previous sheet that carried no rows subtracts nothing either",
    );
  }

  // ── 3. Products that do not line up between the two sheets ──────────────────────────────────────
  {
    const current = [
      { productCode: "SA001", netQty: 400 },
      { productCode: "NEW01", netQty: 45 },
    ];
    const thisWeek = decumulateProductNet(current, [
      { productCode: "SA001", netQty: 300 },
      { productCode: "GONE1", netQty: 999 },
    ]);
    assert.equal(own(thisWeek, "NEW01"), 45, "a product the previous sheet never carried has nothing to subtract");
    assert.equal(own(thisWeek, "GONE1"), undefined, "a product only the previous sheet carried has no figure to print");
    assert.equal(own(thisWeek, "SA001"), 100, "and it does not leak into a product that is on both");
  }

  // ── 4. Matching and rounding ────────────────────────────────────────────────────────────────────
  {
    const thisWeek = decumulateProductNet(
      [{ productCode: "sa001", netQty: 0.3 }],
      [
        { productCode: " SA001 ", netQty: 0.1 },
        { productCode: "SA001", netQty: 0.1 },
      ],
    );
    assert.equal(thisWeek[0].productCode, "sa001", "a result keeps the code its own sheet gave it, so the screen finds it");
    assert.equal(thisWeek[0].netQty, 0.1, "products match trimmed and upper-cased, their branches add up, and 0.3 − 0.2 is 0.1 not 0.09999999999999998");
    assert.equal(
      decumulateProductNet([{ productCode: "SA001", netQty: 80 }], [{ productCode: "SA001", netQty: 100 }])[0].netQty,
      -20,
      "a fall in a cumulative sheet stays visible as a negative week, as the sheet-level figure shows it",
    );
  }

  // ── 5. The screen's figure follows the same pick as the tiles ───────────────────────────────────
  {
    const productNetQty = decumulateProductNet(
      week2.byProduct.map((product) => ({ productCode: product.productCode, netQty: product.netQty })),
      storedRows(week1Rows),
    );
    const tw: Pick<WeeklyThisWeekOnly, "netQty" | "productNetQty"> = {
      netQty: week2.totals.netQty - week1.totals.netQty,
      productNetQty,
    };

    const first = weeklyUploadUnitScope(week2, null);
    assert.equal(first?.productKey, "SA001", "with nothing picked the tiles show the top product by value");
    assert.equal(weeklyUploadThisWeekUnits(tw, first), 100, "so This week only shows that product's own week, not the 124 the sheet adds up to");

    const picked = weeklyUploadUnitScope(week2, "SS001");
    assert.equal(weeklyUploadThisWeekUnits(tw, picked), 24, "a pick moves This week only with the tiles");

    assert.equal(
      weeklyUploadThisWeekUnits(tw, weeklyUploadUnitScope(week2, "NOT-IN-THIS-FILE")),
      100,
      "a stale pick falls back to the top product for This week only exactly as it does for the tiles",
    );

    const oneProduct = sheet("2026-09-11", week2Rows.filter((entry) => entry.productCode === "SA001"));
    assert.equal(
      weeklyUploadThisWeekUnits({ netQty: 100, productNetQty: null }, weeklyUploadUnitScope(oneProduct, null)),
      100,
      "a sheet of one product prints the sheet-level figure, which is that product's",
    );

    assert.equal(weeklyUploadThisWeekUnits(tw, null), null, "no product to show keeps the dash");
    assert.equal(
      weeklyUploadThisWeekUnits({ netQty: 124, productNetQty: null }, first),
      null,
      "a previous sheet whose rows could not be read keeps the dash: 124 adds two products and is never printed in its place",
    );
    assert.equal(
      weeklyUploadThisWeekUnits({ netQty: 124, productNetQty: productNetQty.filter((entry) => entry.productCode !== "SA001") }, first),
      null,
      "and so does a product with no line of its own",
    );
  }

  // ── 6. The wiring: the server fills the figure, the screen prints only the picked product's ─────
  {
    const service = readFileSync(fileURLToPath(new URL("../src/lib/sales/weekly/service.ts", import.meta.url)), "utf8");

    const loader = between(service, "async function loadPriorSheetProductNet(", "/**\n * De-cumulate this sheet");
    assert.match(loader, /\.from\("weekly_sales_rows"\)/, "the previous sheet's stored rows are read");
    assert.match(loader, /\.eq\("batch_id", batchId\)/, "and only that sheet's");
    assert.match(loader, /fetchAllRowsKeyset</, "a sheet runs past the 1,000 rows one read returns, so it is paged, never read once");
    assert.match(loader, /product_code \|\| row\.product_name/, "rows are keyed as the sheet's By product table is: the code, else the name");
    assert.match(loader, /catch \(error\) \{[\s\S]*return null;/, "an unreadable sheet answers null, never an empty list that would subtract nothing");

    const compute = between(service, "async function computeThisWeekOnly(", "// ── upload → validate → store");
    assert.match(compute, /byProduct: readonly WeeklyThisWeekProductNet\[\],/, "computeThisWeekOnly is handed the sheet's per-product totals");
    assert.match(compute, /productNetQty: decumulateProductNet\(byProduct, null\),/, "a first sheet, or one that is not cumulative, has each product's own cumulative as its week");
    assert.match(
      compute,
      /productNetQty: priorProducts \? decumulateProductNet\(byProduct, priorProducts\) : null,/,
      "against a previous sheet each product is subtracted from its own line, and an unreadable sheet gives none",
    );
    assert.match(compute, /\.select\("id, week_start, week_number, total_sales_value, total_net_qty"\)/, "the previous batch's id is read, to find its rows");
    assert.match(compute, /if \(!weeklyDistributorIsCumulative\(distributorCode\)\) \{\s*return firstSheet\(\);/, "the non-cumulative exemption still skips the previous-sheet lookup entirely");
    assert.match(
      service,
      /parsed\.result\.totals,\s*parsed\.result\.byProduct\.map\(\(product\) => \(\{ productCode: product\.productCode, netQty: product\.netQty \}\)\),\s*\);/,
      "the upload passes its By product totals in, keyed as the picker's options are",
    );

    const upload = readFileSync(
      fileURLToPath(new URL("../src/components/sales/weekly/weekly-upload-workspace.tsx", import.meta.url)),
      "utf8",
    );
    assert.match(
      upload,
      /const thisWeekUnits = tw \? weeklyUploadThisWeekUnits\(tw, unitScope\) : null;/,
      "the panel asks the shared rule, with the same scope as the tiles",
    );
    const panel = between(upload, "{/* This week only", "{/* Blocking reasons */}");
    assert.match(panel, /Net units\{ofProduct\}: /, "the panel names the product its net units are");
    assert.match(panel, /thisWeekUnits == null \? "—" : num\(thisWeekUnits\)/, "and prints only that figure, a dash when there is none");
    assert.doesNotMatch(panel, /tw\.netQty/, "the panel never prints the sheet-level figure, which adds every product");
    assert.match(panel, /scopeUnits\(unitScope\?\.totals\.netQty\)/, "its 'cumulative' figure is the picked product's own");
  }
}
