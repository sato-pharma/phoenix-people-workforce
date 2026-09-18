import assert from "node:assert/strict";

import { parseSalesRow } from "../src/lib/sales/validation.ts";

/**
 * A flat sales sheet (the "sales-queue-upload-template" every production upload has used) does not
 * require a Factory Price: the parser passes `skipFactoryPrice` for it. But the target block only
 * kept a stated Target Units when it could also price it, so a row with Target Units and no price
 * fell through to the "both empty" branch: its target was zeroed and the row carried a note saying
 * the sheet gave no target at all.
 *
 * The stated number is kept now, and only the half that needs the price stays at zero, with a note
 * that names the missing price.
 */

// One Pedia row as the flat template lays it out, with Target Units and no Factory Price column.
function flatRow(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    HR_ID: "P-1043",
    "D.M.": "Sample DM",
    Line: "Pedia",
    Sys: "Giza 2",
    "Type of Sales": "Pharmacy",
    Family: "Guamusin",
    PRODUCT: "Guamusin",
    Month: 5,
    Year: 2026,
    "Sales Units": 40,
    "Sales Value": 2430,
    ...extra,
  };
}

const FLAT = { skipFactoryPrice: true };
const notesOf = (record: { validationNotes: string[] }) => record.validationNotes.join("\n");

export function runSalesFlatSheetKeepsStatedTargetUnitsTests() {
  // HEADLINE — the sheet says 120 units of target and gives no price: the 120 is kept.
  const unitsNoPrice = parseSalesRow(flatRow({ "Target Units": 120 }), "Pedia", 7, FLAT);
  assert.equal(
    unitsNoPrice.targetUnits,
    120,
    `a flat row stating Target Units 120 with no Factory Price keeps its 120 units of target (got ${unitsNoPrice.targetUnits})`,
  );
  assert.equal(unitsNoPrice.targetValue, 0, "with no price the target VALUE cannot be worked out, so it stays 0");
  assert.ok(
    notesOf(unitsNoPrice).includes("Factory Price is missing") && notesOf(unitsNoPrice).includes("Target Units 120"),
    `the note names the missing price and the units it kept (got: ${notesOf(unitsNoPrice)})`,
  );
  assert.ok(
    !notesOf(unitsNoPrice).includes("Target Units and Target Value are empty"),
    "the row must not claim the sheet gave no target",
  );
  assert.equal(unitsNoPrice.validationState, "warning", "a kept target with a missing price is a warning, not a refusal");

  // With a price, Target Value is still derived from the units as before.
  const unitsWithPrice = parseSalesRow(flatRow({ "Target Units": 120, "Factory Price": 60.75 }), "Pedia", 8, FLAT);
  assert.equal(unitsWithPrice.targetUnits, 120);
  assert.equal(unitsWithPrice.targetValue, 7290, "120 units at 60.75 is a 7,290 target value");

  // Target Value with no units and no price: the value is kept, and the note does not claim a derivation.
  const valueNoPrice = parseSalesRow(flatRow({ "Target Value": 7290 }), "Pedia", 9, FLAT);
  assert.equal(valueNoPrice.targetValue, 7290, "a stated Target Value is kept");
  assert.equal(valueNoPrice.targetUnits, 0, "with no price the target UNITS cannot be worked out");
  assert.ok(
    !notesOf(valueNoPrice).includes("derived it from Target Value and Factory Price"),
    `nothing was derived, so the note must not say it was (got: ${notesOf(valueNoPrice)})`,
  );
  assert.ok(notesOf(valueNoPrice).includes("Factory Price is missing"), "the note names the missing price");

  // A sheet that really gives no target still imports with zero target and says so.
  const noTarget = parseSalesRow(flatRow({}), "Pedia", 10, FLAT);
  assert.equal(noTarget.targetUnits, 0);
  assert.equal(noTarget.targetValue, 0);
  assert.ok(notesOf(noTarget).includes("Target Units and Target Value are empty"), "an empty target is still reported as empty");

  // A target that is not a number fails the row, and is not also reported as empty.
  const badUnits = parseSalesRow(flatRow({ "Target Units": "twelve" }), "Pedia", 11, FLAT);
  assert.equal(badUnits.validationState, "failed", "a non-numeric Target Units refuses the row");
  assert.ok(!notesOf(badUnits).includes("Target Units and Target Value are empty"), "a refused target is not also called empty");
}
