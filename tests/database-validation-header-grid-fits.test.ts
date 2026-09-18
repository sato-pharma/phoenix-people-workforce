import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HEADER_GRID_COLUMNS } from "../src/lib/sales/normalizer/profile-grid.ts";

/**
 * The Database Validation tab's "Distributor → Phoenix header mapping" grid, pinned against the
 * owner's FITS-THE-SCREEN golden rule (AGENTS.md §4): never a horizontal scroll, always mobile AND
 * desktop friendly, and `overflow-x-auto` over nowrap cells IS the bug rather than the fix.
 *
 * It was exactly that: an `overflow-x-auto` wrapper around an auto-layout table of thirteen
 * columns (Distributor plus the twelve HEADER_GRID_COLUMNS), every cell `whitespace-nowrap`, with
 * raw sheet headers such as "FROM_COMPANY_ENTITY_NAME" inside them. The content box is 669px at a
 * 1024px viewport, where the sidebar appears, so the grid always scrolled sideways.
 *
 * The fix MERGES columns rather than shrinking type: Distrub ID rides in the Distributor cell (it
 * is always the distributor's own code), and the other eleven headers sit in five labelled groups,
 * so the table is six `table-fixed` columns over a percentage colgroup. Values wrap; nothing is
 * cut short. Mobile gets one card per distributor.
 *
 * The checks are scoped to the grid's own section of the file. The customer-map and blocked-rows
 * tables further down the same file are separate, and are not what this test pins.
 */

const FILE = "src/components/sales/database-validation-tab.tsx";

function gridSection(source: string): string {
  const start = source.indexOf('title="Distributor → Phoenix header mapping"');
  assert.ok(start >= 0, `${FILE}: could not find the header grid's AdminTableShell by its title.`);
  const end = source.indexOf("</AdminTableShell>", start);
  assert.ok(end > start, `${FILE}: could not find the end of the header grid's AdminTableShell.`);
  return source.slice(start, end);
}

function classTokensOf(fragment: string): Set<string> {
  const values = [
    ...[...fragment.matchAll(/className="([^"]*)"/g)].map((m) => m[1]),
    ...[...fragment.matchAll(/className=\{`([^`]*)`\}/g)].map((m) => m[1]),
    ...[...fragment.matchAll(/"([^"]*)"\s*:\s*"([^"]*)"/g)].flatMap((m) => [m[1], m[2]]),
  ];
  return new Set(values.flatMap((value) => value.split(/\s+/)).filter(Boolean));
}

export function runDatabaseValidationHeaderGridFitsTests() {
  const source = readFileSync(FILE, "utf8");
  const grid = gridSection(source);
  const pairsStart = source.indexOf("function HeaderPairs");
  assert.ok(pairsStart >= 0, `${FILE}: the HeaderPairs cell renderer is gone — has the grid been restructured?`);
  const pairs = source.slice(pairsStart, source.indexOf("export function DatabaseValidationTab"));
  const tokens = classTokensOf(grid + pairs);

  // 1. No sideways scroller and no nowrap: the two classes that made the grid scroll.
  for (const banned of ["overflow-x-auto", "overflow-x-scroll", "whitespace-nowrap"]) {
    assert.ok(
      !tokens.has(banned),
      `${FILE}: "${banned}" is back in the header grid. It scrolled sideways inside a 669px ` +
        `content box. Fit by MERGING columns into the labelled groups instead.`,
    );
  }
  const minWidths = [...tokens].filter((t) => t.startsWith("min-w-[")).sort();
  assert.deepEqual(minWidths, [], `${FILE}: the header grid has min-width floors ${JSON.stringify(minWidths)}.`);

  // 2. The ellipsis ban, which wrapping does not weaken.
  for (const banned of ["truncate", "text-ellipsis"]) {
    assert.ok(!tokens.has(banned), `${FILE}: "${banned}" is in the header grid. Nothing is cut short; let it wrap.`);
  }

  // 3. Square edges: no rounding class of any kind in the grid.
  const rounded = [...tokens].filter((t) => /^rounded(?:-|$)/.test(t));
  assert.deepEqual(rounded, [], `${FILE}: the header grid adds rounding ${JSON.stringify(rounded)} (square-edge rule).`);

  // 4. The desktop table is fixed-layout over a percentage colgroup totalling 100%.
  const table = grid.match(/<table className="([^"]*)"/);
  assert.ok(table, `${FILE}: could not find the header grid's <table>.`);
  const tableClasses = table[1].split(/\s+/);
  assert.ok(tableClasses.includes("w-full") && tableClasses.includes("table-fixed"), `${FILE}: the header grid table is "${table[1]}" — it needs "w-full table-fixed".`);
  const colgroup = grid.match(/<colgroup>\s*((?:<col className="[^"]*" \/>\s*)+)<\/colgroup>/);
  assert.ok(colgroup, `${FILE}: the header grid table has no <colgroup> of <col className="w-[N%]" /> entries.`);
  const widths = [...colgroup[1].matchAll(/w-\[(\d+(?:\.\d+)?)%\]/g)].map((m) => Number(m[1]));
  assert.equal(widths.reduce((sum, w) => sum + w, 0), 100, `${FILE}: the colgroup widths ${JSON.stringify(widths)} do not total 100%.`);

  // 5. One <col> per rendered column: the Distributor cell plus one per group.
  const groupsLiteral = source.match(/const HEADER_GRID_GROUPS[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(groupsLiteral, `${FILE}: could not find the HEADER_GRID_GROUPS literal.`);
  const groupKeys = [...groupsLiteral[1].matchAll(/keys:\s*\[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((k) => k[1]));
  assert.equal(
    widths.length,
    groupKeys.length + 1,
    `${FILE}: ${widths.length} <col> entries for ${groupKeys.length} groups plus the Distributor ` +
      `column. They must agree, or every column after the mismatch is sized by the wrong <col>.`,
  );
  assert.ok(groupKeys.length + 1 < HEADER_GRID_COLUMNS.length, `${FILE}: the grid is back to a column per header — merge them into groups.`);

  // 6. Every Phoenix header is shown: Distrub ID in the Distributor cell, the rest in exactly one
  //    group. A header in no group would still render (the component appends it to the last
  //    group), but it belongs in the group it describes.
  const grouped = groupKeys.flat();
  for (const { key, label } of HEADER_GRID_COLUMNS) {
    if (key === "distrub") continue;
    assert.equal(grouped.filter((k) => k === key).length, 1, `${FILE}: header "${label}" (key "${key}") must sit in exactly one HEADER_GRID_GROUPS entry.`);
  }
  assert.ok(grid.includes("r.cells.distrub"), `${FILE}: the Distributor cell no longer shows Distrub ID.`);

  // 7. Long raw sheet headers wrap inside their cell: the value line carries break-words.
  assert.ok(
    /isDerivedHeaderValue\(p\.value\) \? "break-words[^"]*" : "break-words[^"]*"/.test(pairs),
    `${FILE}: the header value line lost "break-words". "FROM_COMPANY_ENTITY_NAME" is one ` +
      `unbreakable token and runs out of a fixed column without it.`,
  );

  // 8. Admin shell: the table is desktop-only and mobile gets cards.
  assert.ok(/<div className="hidden [^"]*md:block">\s*<table className="w-full table-fixed/.test(grid), `${FILE}: the header grid table must be desktop-only ("hidden … md:block").`);
  assert.ok(/<div className="[^"]*md:hidden">\s*\{headerRows\.map/.test(grid), `${FILE}: the header grid has no mobile card list ("md:hidden" over headerRows).`);
}
