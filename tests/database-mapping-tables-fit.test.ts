import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MASTER_DEFINITIONS, MASTER_KEYS } from "../src/lib/sales/master-data/definitions.ts";
import { lookupHost, masterRowLayout } from "../src/lib/sales/master-data/row-layout.ts";

/**
 * Every table on Sales → Database Mapping, pinned against the owner's FITS-THE-SCREEN golden rule
 * (AGENTS.md §4): never a horizontal scroll, always mobile AND desktop friendly, and
 * `overflow-x-auto` over a `min-width` floor or nowrap cells IS the bug rather than the fix.
 *
 * #4038 fixed the Validation tab's header grid. The page's four other tables were the same
 * defect: the master rows table (`min-w-[720px]`, one column per field, per parent lookup and
 * for Active/Updated/Actions: ten on Brick Master), the import Blocked Rows table
 * (`min-w-[640px]`), the Validation tab's customer map (seven nowrap columns, the address cut
 * short with `truncate`) and its import blocked-rows table. All sat in `overflow-x-auto`.
 *
 * They now fit by MERGING columns, never by shrinking type, and mobile gets cards:
 * - master rows: the locked columns share one identity cell, each lookup sits under the code it
 *   resolves from, and Active and Updated share Status. That is five columns at most
 *   (row-layout.ts), tested below for every master;
 * - customer map: Customer (name, code, distributor), Address (in full, wrapping), and
 *   Brick · Area · Region;
 * - both blocked-rows tables: table-fixed over a colgroup, wrapping.
 */

const WORKSPACE = "src/components/sales/database-mapping-workspace.tsx";
const VALIDATION = "src/components/sales/database-validation-tab.tsx";

// Class names in comments are prose, not markup: strip block comments and whole-line comments.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function assertFits(file: string, expectedTables: number) {
  const source = withoutComments(readFileSync(file, "utf8"));

  // 1. The classes that made these tables scroll or cut text: absent anywhere in the markup.
  for (const banned of ["overflow-x-auto", "overflow-x-scroll", "whitespace-nowrap", "truncate", "text-ellipsis"]) {
    assert.ok(
      !new RegExp(`(^|[\\s"'\`])${banned}($|[\\s"'\`])`, "m").test(source),
      `${file}: "${banned}" is back. The golden rule names a sideways scroller as the bug, and ` +
        `nothing is cut short with an ellipsis. Fit by MERGING columns, and let text wrap.`,
    );
  }
  assert.ok(!source.includes("min-w-["), `${file}: a "min-w-[…]" floor is back. That floor is what pushed a table wider than its box.`);

  // 2. Every table is fixed-layout, full width, and opens with a colgroup.
  const tables = [...source.matchAll(/<table className="([^"]*)">\s*<colgroup>/g)];
  const allTables = [...source.matchAll(/<table\b/g)];
  assert.equal(allTables.length, expectedTables, `${file}: expected ${expectedTables} tables, found ${allTables.length}.`);
  assert.equal(tables.length, expectedTables, `${file}: every <table> must open with a <colgroup> (found ${tables.length} of ${expectedTables}).`);
  for (const [, classes] of tables) {
    const tokens = classes.split(/\s+/);
    assert.ok(tokens.includes("w-full") && tokens.includes("table-fixed"), `${file}: a table is "${classes}". It needs "w-full table-fixed".`);
  }

  // 3. Every static colgroup totals 100%.
  for (const [, cols] of source.matchAll(/<colgroup>\s*((?:<col className="[^"]*" \/>\s*)+)<\/colgroup>/g)) {
    const widths = [...cols.matchAll(/w-\[(\d+(?:\.\d+)?)%\]/g)].map((m) => Number(m[1]));
    assert.equal(widths.reduce((sum, w) => sum + w, 0), 100, `${file}: colgroup widths ${JSON.stringify(widths)} do not total 100%.`);
  }

  // 4. Admin shell: each table is desktop-only, and a mobile card list stands beside it.
  const desktopOnly = (source.match(/"hidden [^"]*md:(?:block|table)"/g) ?? []).length;
  const mobile = (source.match(/"[^"]*\bmd:hidden"/g) ?? []).length;
  assert.equal(desktopOnly, expectedTables, `${file}: ${desktopOnly} desktop-only wrappers for ${expectedTables} tables.`);
  assert.equal(mobile, expectedTables, `${file}: ${mobile} mobile card lists for ${expectedTables} tables.`);
}

export function runDatabaseMappingTablesFitTests() {
  // The rows table's layout, measured for every master rather than trusted from one.
  for (const master of MASTER_KEYS) {
    const def = MASTER_DEFINITIONS[master];
    const layout = masterRowLayout(def);
    const total = layout.widths.reduce((sum, w) => sum + w, 0);
    assert.ok(Math.abs(total - 100) < 1e-9, `${def.label}: row widths ${JSON.stringify(layout.widths)} total ${total}%, not 100%.`);
    assert.equal(layout.widths.length, 1 + layout.fields.length + 2, `${def.label}: one width per rendered column (identity, fields, Status, Actions).`);
    assert.ok(layout.widths.length <= 5, `${def.label}: ${layout.widths.length} columns. Merge rather than add; five is what fits a 669px box.`);

    // Every managed column shows exactly once, and no locked column is offered for editing.
    const shown = [...layout.identity, ...layout.fields].map((c) => c.key);
    assert.deepEqual([...shown].sort(), def.columns.map((c) => c.key).sort(), `${def.label}: every column must show exactly once.`);
    assert.ok(layout.fields.every((c) => !c.locked) || layout.identity.every((c) => !c.locked), `${def.label}: a locked column landed in an editable field cell.`);
    assert.ok(layout.identity.length >= 1, `${def.label}: the identity cell is empty.`);

    // Every lookup is shown under a real column, and none is lost.
    const hosted = [...layout.lookupsByHost.values()].flat().map((l) => l.key).sort();
    assert.deepEqual(hosted, def.displayLookups.map((l) => l.key).sort(), `${def.label}: every parent lookup must show, once.`);
    for (const [host] of layout.lookupsByHost) {
      assert.ok(def.columns.some((c) => c.key === host), `${def.label}: a lookup is hosted by "${host}", which is not a column.`);
    }
  }

  // A chained lookup follows its chain: a brick's Area Name resolves via Area Code, itself a
  // lookup via Block Code, so it sits under Block Code with the rest.
  const bricks = MASTER_DEFINITIONS.bricks;
  const areaName = bricks.displayLookups.find((l) => l.key === "area_name");
  assert.ok(areaName, "Brick Master still carries an Area Name lookup");
  assert.equal(lookupHost(bricks, areaName), "block_code", "a brick's Area Name sits under Block Code, where its chain starts");

  assertFits(WORKSPACE, 2);
  assertFits(VALIDATION, 3);

  const workspace = readFileSync(WORKSPACE, "utf8");
  // The rows table renders from the layout, not one column per field.
  assert.match(workspace, /const layout = masterRowLayout\(def\);/, `${WORKSPACE}: the rows table no longer takes its columns from masterRowLayout.`);
  assert.match(workspace, /\{layout\.widths\.map\(\(width, index\) => \(\s*<col key=\{index\} style=\{\{ width: `\$\{width\}%` \}\} \/>/, `${WORKSPACE}: the rows table's colgroup must come from layout.widths.`);
  // An inline edit takes the cell's width; the Add form keeps its fixed field.
  assert.match(workspace, /fill \? "w-full min-w-0" : "w-48"/, `${WORKSPACE}: ColumnField lost its fill mode, so an inline edit input is a fixed 192px again.`);
  assert.match(workspace, /<ColumnField[^>]*?\n\s*fill\n/, `${WORKSPACE}: the row editor must render ColumnField with "fill".`);

  const validation = readFileSync(VALIDATION, "utf8");
  // The address shows in full and wraps: no hover-title stand-in for text that was cut off.
  assert.ok(!validation.includes("title={c.address}"), `${VALIDATION}: the address is back to a cut-off cell with a hover title.`);
  assert.match(validation, /<td className="break-words[^"]*">\{c\.address \|\| "—"\}<\/td>/, `${VALIDATION}: the customer map's address cell must wrap (break-words).`);
}
