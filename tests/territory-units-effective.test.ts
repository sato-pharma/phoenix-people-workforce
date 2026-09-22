import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Territory Management's area pharmacies list (phx_territory_area_pharmacies) must count a row's
// UNITS on the same basis it VALUES it: the credited-to-area effective units, never the raw
// total_qty. Until 20260922210000 units = sum(total_qty) while value = sum(effective_units × price),
// so a split customer (El Qema bands, the city rule — both locked) read a units number that did not
// match its value and did not reconcile with the closing. Measured on production 2026-09-22: exactly
// 41 rows diverged, all non-direct, gap 1,772.08 units.
//
// The pin reads the NEWEST migration that defines the function, so a later rewrite that reverts units
// to total_qty — or "fixes" the mismatch by pricing total_qty instead — goes red here.

function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

export function runTerritoryUnitsEffectiveTests() {
  const migDir = path.join(process.cwd(), "supabase/migrations");
  const definers = readdirSync(migDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) =>
      /create or replace function public\.phx_territory_area_pharmacies\s*\(/.test(
        strip(readFileSync(path.join(migDir, file), "utf8")).toLowerCase(),
      ),
    );
  const newest = definers[definers.length - 1];
  assert.ok(newest, "some migration defines phx_territory_area_pharmacies");
  assert.ok(
    newest >= "20260922210000_territory_area_pharmacies_effective_units.sql",
    `the newest definition of phx_territory_area_pharmacies (${newest}) predates the effective-units fix`,
  );

  const sql = strip(readFileSync(path.join(migDir, newest), "utf8")).toLowerCase().replace(/\s+/g, " ");

  // Units are aggregated from the credited effective units, NOT the raw total quantity.
  assert.ok(
    sql.includes("r.effective_units as row_units"),
    `${newest}: a row's units must be its credited effective_units, so units share the basis value uses`,
  );
  assert.ok(
    sql.includes("sum(row_units) as units"),
    `${newest}: the units column must aggregate the effective-unit basis`,
  );
  assert.ok(
    !sql.includes("sum(total_qty) as units"),
    `${newest}: units must not revert to raw total_qty — that is the mismatch this fix removes ` +
      "(a split El Qema/city-rule customer overcounted its area and disagreed with its own value)",
  );

  // The value basis must NOT be changed to close the gap the wrong way: a direct order keeps its
  // source value, and a non-direct row keeps effective_units × factory price. Reverting either to
  // total_qty would re-credit an area with goods the split rule sends elsewhere.
  assert.ok(
    sql.includes("case when r.is_direct then coalesce(r.direct_value, 0) else r.effective_units * coalesce(p.factory_price, 0) end"),
    `${newest}: the value basis (direct = source value, else effective_units × factory) must be unchanged`,
  );

  // The area predicate must still match the expression index byte-for-byte, or the fix silently
  // restores the full-table scan (tests/territory-area-index.test.ts covers the index side).
  assert.ok(
    sql.includes("upper(btrim(coalesce(r.area_code, '')))"),
    `${newest}: the area predicate must stay upper(btrim(coalesce(area_code,''))) so the index is used`,
  );
}
