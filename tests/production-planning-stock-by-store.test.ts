import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PP, PP_EN } from "../src/lib/production-planning/strings.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Production Planner — the Stock tab shows the factory and Sato's warehouse APART (2026-11-11).
 *
 * A reviewer, after a stock adjustment and a transfer from the factory to Sato's warehouse: "this
 * change is not appearing clearly from my side … separate the stock quantities to clearly indicate
 * available stock at the factory, available stock at SATO warehouse." Both figures used to share ONE
 * Available cell under small grey labels, so a move from one store to the other read as no change.
 *
 * What would go wrong quietly: the two stores merged back into one cell (or one total) hides every
 * transfer between them while each number on the row still looks right; and an "anything that is not
 * this factory" test for Sato's store would count another factory's lot as Sato's.
 */

const SCREEN = "src/components/production-planning/production-planning-workspace.tsx";

function exportedBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `the screen should export ${name}`);
  const next = source.indexOf("\nexport function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the screen should define ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

export function runProductionPlanningStockByStoreTests() {
  const screen = stripComments(readFileSync(SCREEN, "utf8").replace(/\r\n/g, "\n"));
  const stockTab = exportedBody(screen, "StockTab");

  // 1. The desktop table heads the two stores as two columns, and no longer as one Available column.
  const headings = stockTab.match(/\{\[((?:t\.[A-Za-z]+(?:,\s*)?)+)\]\.map\(\(heading\) => \(/);
  assert.ok(headings, "the Stock tab's table should draw its headings from the bundle");
  assert.deepEqual(
    [...headings[1].matchAll(/t\.([A-Za-z]+)/g)].map((match) => match[1]),
    ["colMaterial", "stockColFactory", "stockColSato", "stockExpired"],
    "🔴 the factory and Sato's warehouse are their OWN columns — one shared Available cell hid a transfer between them",
  );

  // 2. Each of the two cells reads its own store's summed figure and its own lots.
  assert.equal(
    (stockTab.match(/<StoreHeld\b/g) ?? []).length,
    2,
    "one StoreHeld cell for the factory and one for Sato's warehouse",
  );
  assert.match(stockTab, /held=\{factory\}\s+lots=\{material\.stock\.filter\(\(row\) => row\.locationId === ownFactoryId\)\}/);
  assert.match(stockTab, /held=\{own\}\s+lots=\{material\.stock\.filter\(\(row\) => satoStoreIds\.has\(row\.locationId\)\)\}/);

  // 3. Sato's warehouse is a store that is NOT a factory — never "a location not found".
  assert.match(
    stockTab,
    /const satoStoreIds = new Set\(data\.locations\.filter\(\(location\) => !location\.isFactory\)\.map\(\(location\) => location\.id\)\)/,
    "Sato's warehouse is every non-factory store, so another factory's lot can never read as Sato's",
  );
  assert.match(stockTab, /const own = material\.heldByLocation\.find\(\(row\) => satoStoreIds\.has\(row\.locationId\)\)/);

  // 4. The phone cards carry the same split — a block per store, each with its own total.
  assert.match(stockTab, /key: "factory",\s+label: t\.stockColFactory,/);
  assert.match(stockTab, /key: "sato",\s+label: t\.stockColSato,/);

  // 5. A store with a recorded zero is SHOWN with its date (that is the transfer), and only a store
  //    with no report at all reads "nothing recorded".
  const cell = functionBody(screen, "StoreHeld");
  assert.match(cell, /if \(!held\) return <span[^>]*>\{t\.stockNothingHere\}<\/span>;/);
  assert.equal(/qty\s*===\s*"0"|\/\[1-9\]\//.test(cell), false, "a zero balance is not hidden — it is the evidence of the move");
  assert.match(cell, /\{t\.stockAsOf\} <Num>\{held\.newestAsOfDate\}<\/Num>/, "each store says how fresh its figure is");

  // 6. Both languages carry the new headings.
  assert.equal(PP_EN.stockColFactory, "Available at the factory");
  assert.equal(PP_EN.stockColSato, "Available at Sato warehouse");
  assert.equal(PP.stockColFactory, "المتاح في المصنع");
  assert.equal(PP.stockColSato, "المتاح في مخزن ساتو");
}
