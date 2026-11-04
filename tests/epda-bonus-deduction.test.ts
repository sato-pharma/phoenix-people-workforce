import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildBulkAllocation, type BulkAllocationRow } from "../src/lib/sales/closing-bulk-allocation.ts";
import { pickDuplicateUploadClash } from "../src/lib/sales/import-duplicate-guard.ts";
import {
  applyEpdaBonusDeduction,
  epdaBonusDeductionPercent,
} from "../src/lib/sales/import-epda-bonus-deduction.ts";

/**
 * THE EPDA BONUS DEDUCTION — the owner's rule of 2026-11-04, from the October 2026 closing on:
 * Ivyronc loses 30%, Royafloxacin and Saginko 15%, on EPDA-BULK and EPDA-Pharmacies only, and units
 * stay whole numbers, made on each area's total, and the closing's spread of the bulk book keeps them whole.
 *
 * What this pins: his own two examples, that no row ever carries a decimal, that nothing outside the
 * three products, the two books and the months moves, that the sheet's units survive in `rawRow`,
 * and that both routes into `source_of_sales_import_rows` take the deduction before any total.
 */
type Row = {
  areaCode: string;
  distributorCode: string;
  invoiceDate: string;
  isDirect: boolean;
  productCode: string;
  qty: number;
  rawRow: Record<string, string>;
  value: number;
};

const row = (over: Partial<Row> & { qty: number }): Row => ({
  areaCode: "CA1",
  distributorCode: "EP-PHS",
  invoiceDate: "2026-10",
  isDirect: false,
  productCode: "IV001",
  rawRow: { SalesOrReturnQty: String(over.qty) },
  value: over.qty * 30.375,
  ...over,
});
const deduct = (rows: Row[]) => applyEpdaBonusDeduction(rows, (r) => r.invoiceDate);
const units = (rows: readonly Row[]) => rows.reduce((sum, r) => sum + r.qty, 0);

export function runEpdaBonusDeductionTests() {
  // 1. HIS EXAMPLES. "if ivyronc sales is 6000 so we consider only 4200 bottle", on a bulk book whose
  //    invoiced areas the closing ignores for Ivyronc, so the book is one group.
  {
    const book = deduct([
      row({ distributorCode: "EP-BK", areaCode: "CA1", qty: 3333 }),
      row({ distributorCode: "EP-BK", areaCode: "AX1", qty: 2667 }),
    ]);
    assert.equal(units(book), 4200, "6000 Ivyronc on the bulk book reads 4200");
    assert.ok(book.every((r) => Number.isInteger(r.qty)), "and every row is a whole number");
    assert.equal(deduct([row({ qty: 100 })])[0].qty, 70, "Ivyronc 100 in one area reads 70");
    assert.equal(deduct([row({ qty: 100, productCode: "RO001" })])[0].qty, 85, "Royafloxacin loses 15%");
    assert.equal(deduct([row({ qty: 100, productCode: "SA001" })])[0].qty, 85, "Saginko loses 15%");
  }

  // 2. NEVER A DECIMAL, AND THE AREA'S TOTAL IS WHAT ROUNDS. One-unit pharmacies must not each round on
  //    their own: 1 + 2 + 97 is 100, and 100 at 30% off is 70 whichever way the shares fall.
  {
    const area = deduct([row({ qty: 1 }), row({ qty: 2 }), row({ qty: 97 })]);
    assert.equal(units(area), 70);
    assert.ok(area.every((r) => Number.isInteger(r.qty) && r.qty >= 0));

    const pharmacies = deduct(Array.from({ length: 10 }, () => row({ qty: 1 })));
    assert.equal(units(pharmacies), 7, "ten one-unit lines are seven units, not ten and not zero");

    const twoAreas = deduct([row({ areaCode: "CA1", qty: 15 }), row({ areaCode: "AX1", qty: 15 })]);
    assert.deepEqual(twoAreas.map((r) => r.qty), [11, 11], "each area's own 10.5 rounds to a whole number");

    const decimalSheet = deduct([row({ qty: 1.5 }), row({ qty: 2.5 })]);
    assert.ok(decimalSheet.every((r) => Number.isInteger(r.qty)), "a decimal in the sheet still leaves whole units");
  }

  // 3. A RETURN STAYS A RETURN, and the percentage falls on the net.
  {
    const net = deduct([row({ qty: 20 }), row({ qty: -10 })]);
    assert.equal(units(net), 7);
    assert.ok(net[0].qty > 0 && net[1].qty < 0);
    assert.equal(units(deduct([row({ qty: -100 })])), -70);
    assert.equal(deduct([row({ qty: 0 })])[0].qty, 0);
  }

  // 4. THE VALUE FOLLOWS THE UNITS AT THE ROW'S OWN PRICE, and the sheet's units stay in rawRow.
  {
    const original = row({ qty: 100 });
    const [after] = deduct([original]);
    assert.equal(after.value, 70 * 30.375);
    assert.equal(after.rawRow.SalesOrReturnQty, "100", "raw_row still says what the sheet said");
    assert.equal(original.qty, 100, "the input row is not changed");
    const [saginko] = deduct([row({ qty: 100, productCode: "SA001", value: 100 * 170.52 })]);
    assert.equal(saginko.value, Number((85 * 170.52).toFixed(6)));
  }

  // 5. NOTHING ELSE MOVES. The same array comes back, so the older route's totals are not rebuilt.
  {
    const untouched: Array<[string, Row]> = [
      ["September keeps what it stored", row({ qty: 100, invoiceDate: "2026-09" })],
      ["the main EPDA book counts in full", row({ qty: 100, distributorCode: "EP" })],
      ["another distributor counts in full", row({ qty: 100, distributorCode: "PS" })],
      ["Lacto is not one of the three", row({ qty: 100, productCode: "LA001" })],
      ["Royanoxicam is not Royafloxacin", row({ qty: 100, productCode: "RY001" })],
      ["a direct order is a deal", row({ qty: 100, isDirect: true })],
    ];
    for (const [name, sample] of untouched) {
      const rows = [sample];
      assert.equal(deduct(rows), rows, name);
    }
    assert.equal(deduct([row({ qty: 100, invoiceDate: "2027-01" })])[0].qty, 70, "later months keep the rule");
    assert.equal(deduct([row({ qty: 100, distributorCode: " ep-bk " })])[0].qty, 70, "a stray space or case still matches");
    assert.equal(epdaBonusDeductionPercent("EP-BK", "IV001", null), 0, "no month, no deduction");
    const mixed = deduct([row({ qty: 100 }), row({ qty: 100, productCode: "LA001" })]);
    assert.deepEqual(mixed.map((r) => r.qty), [70, 100], "a book's other products are left alone");
  }

  // 6. THE CLOSING'S SPREAD OF THE BULK BOOK'S IVYRONC STAYS WHOLE FROM OCTOBER. It moves the book by
  //    each area's share of the other distributors' value, and those shares are never round numbers.
  {
    const rowOf = (over: Partial<BulkAllocationRow>): BulkAllocationRow => ({
      areaCode: "D21",
      clientCode: "C-1",
      clientName: "صيدلية النور",
      distributorCode: "PS",
      includedInClosing: true,
      isDirect: false,
      officialLine: "Pedia",
      productCode: "LA001",
      qty: 10,
      salesValue: 1000,
      ...over,
    });
    const rows = [
      rowOf({ areaCode: "D21", salesValue: 1000 }),
      rowOf({ areaCode: "D15", salesValue: 1000 }),
      rowOf({ areaCode: "D14", salesValue: 1000 }),
      rowOf({ areaCode: "AB1", distributorCode: "EP-BK", productCode: "IV001", qty: 3190, effectiveUnits: 3190, salesValue: 3190 * 30.375 }),
    ];
    const inOf = (period: string) => buildBulkAllocation(rows, period, "Pedia").movements.filter((leg) => leg.inQty !== 0);

    const october = inOf("2026-10");
    assert.equal(october.length, 3);
    assert.ok(october.every((leg) => Number.isInteger(leg.inQty)), "every area takes whole units");
    assert.equal(october.reduce((sum, leg) => sum + leg.inQty, 0), 3190, "and the book's total is exact");
    const money = october.reduce((sum, leg) => sum + leg.inValue, 0);
    assert.ok(Math.abs(money - 3190 * 30.375) < 1e-6, "the value that left is the value that lands");
    for (const leg of october) assert.ok(Math.abs(leg.inValue - leg.inQty * 30.375) < 1e-3, "an area's value is its units at the price");
    const effective = buildBulkAllocation(rows, "2026-10", "Pedia").effectiveMovements.filter((leg) => leg.inQty !== 0);
    assert.ok(effective.every((leg) => Number.isInteger(leg.inQty)), "the attribution measure is whole as well");

    assert.ok(inOf("2026-09").some((leg) => !Number.isInteger(leg.inQty)), "September keeps what it published");
  }

  // 7. THE SAME FILE ACROSS THE START MONTH IS STILL THE SAME FILE. September stored it in full and
  //    October would store it deducted, so comparing the two totals as they stand would let it through.
  {
    const sheet = [row({ qty: 1000 }), row({ qty: 4000, productCode: "LA001", value: 4000 })];
    const qtyAt = (period: string | null) => units(applyEpdaBonusDeduction(sheet, () => period));
    const valueAt = (period: string | null) =>
      applyEpdaBonusDeduction(sheet, () => period).reduce((sum, r) => sum + r.value, 0);
    const stored = (period: string) => ({
      id: period,
      period,
      file_name: "book.xlsx",
      status: "validated",
      total_rows: 2,
      total_qty: qtyAt(period),
      total_value: valueAt(period),
    });
    const candidate = (period: string) => ({
      fileName: "book.xlsx",
      period,
      totalRows: 2,
      totalQty: qtyAt(period),
      totalValue: valueAt(period),
      totalQtyAt: qtyAt,
      totalValueAt: valueAt,
    });
    assert.equal(qtyAt("2026-09"), 5000);
    assert.equal(qtyAt("2026-10"), 4700);
    assert.equal(pickDuplicateUploadClash([stored("2026-09")], candidate("2026-10"))?.period, "2026-09", "September re-dated to October");
    assert.equal(pickDuplicateUploadClash([stored("2026-10")], candidate("2026-09"))?.period, "2026-10", "October re-dated to September");
    assert.equal(pickDuplicateUploadClash([stored("2026-10")], candidate("2026-11"))?.period, "2026-10", "two months both deducted");
    assert.equal(pickDuplicateUploadClash([{ ...stored("2026-09"), total_qty: 4999 }], candidate("2026-10")), null, "a different file passes");
  }

  // 8. BOTH ROUTES INTO source_of_sales_import_rows TAKE IT, BEFORE ANY TOTAL IS TAKEN. Neither can run
  //    here without a database, and a route that skipped it would announce the undeducted figure.
  {
    const normalized = readFileSync("src/lib/sales/normalizer/service.ts", "utf8");
    const applied = normalized.indexOf("const rows = applyEpdaBonusDeduction(");
    assert.ok(applied > 0, "persistNormalizedBatch deducts");
    assert.ok(applied < normalized.indexOf("const totalQty = rows.reduce", applied), "before its totals");
    assert.match(normalized, /totalQtyAt: \(atPeriod\) =>/, "and its duplicate check crosses the start month");

    const older = readFileSync("src/lib/sales/monthly-distributor-import.ts", "utf8");
    const route = older.slice(older.indexOf("export async function persistDistributorSalesUpload"));
    assert.ok(route.indexOf("applyEpdaBonusDeduction(sheetRows") > 0, "persistDistributorSalesUpload deducts");
    assert.ok(
      route.indexOf("applyEpdaBonusDeduction(sheetRows") < route.indexOf("total_qty: storedTotals.totalQty"),
      "before the batch's totals",
    );
    assert.match(route, /totalQtyAt: \(period\) =>/, "and its duplicate check crosses the start month");
    assert.ok(route.indexOf("insertSourceOfSalesRows(supabase, batchId, parsedRows)") > 0, "and stores the deducted rows");
  }
}
