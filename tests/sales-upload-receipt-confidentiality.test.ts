import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReconciliation } from "../src/lib/sales/sales-upload.ts";
import type { NormalizeResult } from "../src/lib/sales/normalizer/types.ts";

/**
 * The Analyze/Commit receipt's Total value summed EVERY coded row, while the tables rendered under
 * it strip the confidential products (buildPreviewBreakdowns takes the exclusion list; this did
 * not). So the receipt stated a total the tables could not account for — and the difference IS the
 * hidden figure.
 *
 * It is not a small gap: those three products are 81.5% of all sales value. And SFE Manager is the
 * ONLY role holding `sales:import` while not being CEO or Super Admin, so the one person who uses
 * this screen daily is exactly the one the rule exists to hide them from.
 *
 * Row counts deliberately stay whole: they answer "did we account for every row we read", a
 * file-integrity question, and the reconciliation assert depends on them summing to totalRows.
 */

const SRC = readFileSync(new URL("../src/lib/sales/sales-upload.ts", import.meta.url), "utf8");

function makeResult(coded: { qty: number; value: number; productCode: string }[]): NormalizeResult {
  return {
    coded,
    distributorCode: "PS",
    exceptions: [],
    ignoredRows: [],
    blankCustomerRows: [],
    summary: {
      brickResolved: coded.length,
      blankCustomerSkipped: 0,
      fullyCoded: coded.length,
      ignored: 0,
      productResolved: coded.length,
      totalRows: coded.length,
    },
  } as unknown as NormalizeResult;
}

const rows = makeResult([
  { qty: 10, value: 1000, productCode: "AAA111" },
  { qty: 5, value: 8000, productCode: "LA003" }, // confidential
  { qty: 2, value: 200, productCode: "BBB222" },
]);

export function runSalesUploadReceiptConfidentialityTests() {
  // 1. A viewer who may see everything gets the complete total, exactly as before.
  const full = buildReconciliation(rows);
  assert.equal(full.totalValue, 9200, "with no exclusion the receipt still totals every coded row");
  assert.equal(full.totalQty, 17, "and every unit");

  // 2. A restricted viewer's total excludes what the tables below already hide.
  const stripped = buildReconciliation(rows, ["LA003"]);
  assert.equal(stripped.totalValue, 1200, "the confidential product's value must not reach the receipt");
  assert.equal(stripped.totalQty, 12, "nor its units — quantity leaks magnitude too");

  // 3. THE INVARIANT: row counts are file integrity and must not move. If exclusion changed them,
  //    the reconciliation assert would start failing on legitimate files.
  assert.equal(stripped.rowsRead, full.rowsRead, "row counts are file-level and never filtered");
  assert.equal(stripped.rowsCoded, full.rowsCoded, "including the coded count");

  // 4. Codes are compared case- and whitespace-insensitively; a padded or lower-cased entry in the
  //    exclusion list must not silently fail to hide anything.
  assert.equal(
    buildReconciliation(rows, ["  la003  "]).totalValue,
    1200,
    "a differently-cased or padded code must still hide the product",
  );

  // 5. An unrelated code hides nothing — the filter must not be a blanket.
  assert.equal(buildReconciliation(rows, ["ZZZ999"]).totalValue, 9200, "an unmatched code changes nothing");

  // 6. The wiring: BOTH receipts go to the same viewer, so both must pass the list. A correct
  //    filter that neither call site uses changes nothing.
  assert.ok(
    SRC.includes("buildReconciliation(rec.result, excludeProductCodes)"),
    "the analyze receipt must be built with the viewer's exclusion list",
  );
  assert.ok(
    SRC.includes("buildReconciliation(result, excludeProductCodes)"),
    "and so must the commit receipt — it is returned to the same viewer",
  );
}
