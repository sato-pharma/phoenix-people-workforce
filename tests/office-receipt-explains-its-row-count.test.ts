import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// THE OFFICE RECEIPT MUST SAY WHAT ITS "Rows Read" NUMBER IS.
//
// Every other channel imports 1 sheet row → 1 stored row, so `rowCount` — rendered as "Rows Read"
// in sales-import-workspace — agrees with the file. Office does not: it reads a PIVOT of product
// rows and emits one allocated slice per (brick × product). Measured on production, July 2026
// stored total_rows = importable_rows = 3,591 (slices) for a pivot of a few dozen product rows.
//
// Worse, the field FLIPS meaning: on the blocked path it is the pivot's product-row count instead.
// Same label, two unrelated quantities, nothing on screen saying which.
//
// The number is deliberately NOT redefined — `rowCount` feeds the batch's stored `total_rows`, and
// every Office batch since 2026-03 holds the slice count. Changing the meaning would make future
// batches silently incomparable with past ones. The receipt gains the missing figure instead.

const ALLOCATION = fileURLToPath(new URL("../src/lib/sales/office-allocation.ts", import.meta.url));

function testBothPathsExplainTheirRowCount() {
  const source = readFileSync(ALLOCATION, "utf8");

  assert.ok(
    source.includes("Office reads a pivot, not a row list:"),
    "the validated receipt must state the pivot→slice relationship",
  );
  assert.ok(
    source.includes("Nothing was allocated:"),
    "the blocked receipt must state that its Rows Read means something different",
  );

  // The validated advisory must be UNCONDITIONAL. A reconciliation figure that only appears when
  // something already looks wrong is not a reconciliation — there is nothing to compare against on
  // the runs that matter.
  const advisoryAt = source.indexOf("Office reads a pivot, not a row list:");
  const nationalGuardAt = source.indexOf("if (nationalProducts.length > 0)");
  assert.ok(advisoryAt > 0 && nationalGuardAt > 0, "both advisory blocks must exist");
  assert.ok(
    advisoryAt < nationalGuardAt,
    "the pivot advisory must be pushed before the conditional one, i.e. on every upload",
  );
}

function testTheStoredRowCountIsNotRedefined() {
  const source = readFileSync(ALLOCATION, "utf8");

  // These two are what the batch stores. Changing either would alter the meaning of total_rows /
  // importable_rows for future Office batches while every historical one keeps the old meaning —
  // a silent, invisible break that is worse than the mislabel this change fixes.
  assert.ok(source.includes("rowCount: parsedRows.length"), "the validated rowCount must stay the slice count");
  assert.ok(source.includes("importableRows: parsedRows.length"), "importableRows must stay the slice count");
  assert.ok(source.includes("rowCount: totalNames"), "the blocked rowCount must stay the pivot count");
}

function testTheLockedRegionIsUntouched() {
  // This file is protected and its formula is mechanically pinned. The advisories live outside the
  // markers; the guard here is a cheap tripwire so a future edit to this area cannot drift inside
  // the locked block without the lock test being the only thing that notices.
  const source = readFileSync(ALLOCATION, "utf8");
  const start = source.indexOf("GOLDEN RULE · LOCKED · START");
  const end = source.indexOf("GOLDEN RULE · LOCKED · END");
  assert.ok(start > 0 && end > start, "the locked markers must both still be present, in order");

  const locked = source.slice(start, end);
  assert.ok(!locked.includes("advisories"), "no advisory may be added inside the locked region");
  assert.ok(
    locked.includes("function allocateProduct(units: number, weights: OfficeAreaWeights)"),
    "allocateProduct must remain inside the locked region",
  );
  assert.ok(
    locked.includes("if (!(units > 0)) return [];"),
    "the negative-units guard is the owner's to change, not this change's — it must be untouched",
  );
}

export function runOfficeReceiptExplainsItsRowCountTests() {
  testBothPathsExplainTheirRowCount();
  testTheStoredRowCountIsNotRedefined();
  testTheLockedRegionIsUntouched();
}
