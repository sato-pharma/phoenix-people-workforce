import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Territory Management's area pharmacies list (phx_territory_area_pharmacies) must count a row's
// UNITS on the same basis it VALUES it, and that basis must be the Monthly Closing's — the only
// source of truth for any sales figure in this system.
//
// WHAT THIS REPLACES, AND WHY. 20260922210000 moved the units column from `total_qty` to
// `effective_units` to close a real mismatch (units from one basis, value from another). The
// mismatch was real; the reason given for the direction was not. That migration, and the pin that
// enforced it, called effective_units "the credited-to-area effective units" produced by El Qema's
// warehouse bands and the city rule. Measured on production 2026-10-02, it is nothing of the kind:
//
//   * Both columns are written by the SAME expression. phx_refresh_sos_customer_directory_rollup and
//     phx_backfill_sos_customer_directory_rollup each compute sum(coalesce(r.qty, 0)) for
//     effective_units AND for total_qty, so for every row either writer has produced the two are
//     identical. No split is recorded in that table at all — the bands and the city rule are applied
//     in store-sales-city-split.ts at read time and the area-level result is stored in
//     au.monthly_store_split_net.
//
//   * The 41 rows that did diverge were all El Qema 2026-08, 30 customers, 0 direct, gap 1,772.08
//     packs, and on those rows effective_units equals the distributor's invoiced value / factory
//     price — that distributor's own trade discount (20% on client 3743, 22% on 2678) carried into
//     the PACK count. They are stale from an earlier importer.
//
//   * So enforcing effective_units left this page 20% UNDER the published closing on those
//     customers: the closing said 4,532 packs / 1,223,640.00 EGP for client 3743 where the page said
//     3,625.60 / 978,912.00. Owner instruction, 2026-10-02: "fix Territory Management to match the
//     August closing".
//
// Setting effective_units = total_qty on those 41 rows is what the live writer would produce and was
// tried first; phx_reject_write_to_locked_closing refuses it, because Pedia 2026-08 is locked by the
// owner and a published month is never corrected. Hence the reader moved instead.
//
// The pin reads the NEWEST migration that defines the function, so a rewrite that puts the units back
// on a discount-bearing basis, or that re-opens the units/value mismatch in either direction, goes
// red here.

function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

function newestDefiner(migDir: string): string {
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
  return newest;
}

export function runTerritoryUnitsClosingBasisTests() {
  const migDir = path.join(process.cwd(), "supabase/migrations");
  const newest = newestDefiner(migDir);
  assert.ok(
    newest >= "20261002191500_territory_area_pharmacies_reads_total_qty.sql",
    `the newest definition of phx_territory_area_pharmacies (${newest}) predates the closing-basis fix`,
  );

  const sql = strip(readFileSync(path.join(migDir, newest), "utf8")).toLowerCase().replace(/\s+/g, " ");

  // 1. The units are the closing's basis.
  assert.ok(
    sql.includes("r.total_qty as row_units"),
    `${newest}: a row's units must be total_qty — the basis the Monthly Closing counts, which is the ` +
      "only source of truth for a sales figure (AGENTS.md section 4)",
  );
  assert.ok(
    !sql.includes("r.effective_units as row_units"),
    `${newest}: units must not go back to effective_units — on El Qema's August rows that column ` +
      "carries the distributor's own trade discount in the pack count, which put this page 20% under " +
      "the published closing (1,772.08 packs / 478,461.60 EGP)",
  );
  assert.ok(
    sql.includes("sum(row_units) as units"),
    `${newest}: the units column must aggregate that one basis`,
  );

  // 2. Units and value still share ONE basis — the mismatch the 2026-09-22 fix was right about. A
  //    direct order keeps its source value (owner rule, locked); every other row is total_qty priced.
  assert.ok(
    new RegExp(
      String.raw`case when r\.is_direct then coalesce\(r\.direct_value, 0\) else r\.total_qty \* ` +
        String.raw`coalesce\((?:p\.factory_price|public\.phx_factory_price\([^)]*\)|[a-z_]+\.period_price), 0\) end`,
    ).test(sql),
    `${newest}: the value basis must be direct = source value, else total_qty x factory price — the ` +
      "same basis as the units, so the two columns can never disagree again",
  );

  // 3. The area predicate must still match the expression index byte-for-byte, or the change silently
  //    restores the full-table scan (tests/territory-area-index.test.ts covers the index side).
  assert.ok(
    sql.includes("upper(btrim(coalesce(r.area_code, '')))"),
    `${newest}: the area predicate must stay upper(btrim(coalesce(area_code,''))) so the index is used`,
  );
}

// The premise the fix rests on, pinned so it cannot rot silently: BOTH writers of the customer
// directory rollup must compute effective_units and total_qty from the SAME expression. While that
// holds, reading total_qty is safe for every row ever written. If someone ever makes effective_units
// a genuine credited-to-area basis, this goes red and the decision above has to be re-taken rather
// than quietly inherited.
export function runDirectoryRollupUnitColumnsAgreeTests() {
  const migDir = path.join(process.cwd(), "supabase/migrations");
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();

  for (const writer of [
    "phx_refresh_sos_customer_directory_rollup",
    "phx_backfill_sos_customer_directory_rollup",
  ]) {
    const definers = files.filter((file) =>
      new RegExp(String.raw`create or replace function public\.${writer}\s*\(`).test(
        strip(readFileSync(path.join(migDir, file), "utf8")).toLowerCase(),
      ),
    );
    const newest = definers[definers.length - 1];
    assert.ok(newest, `some migration defines ${writer}`);

    const sql = strip(readFileSync(path.join(migDir, newest), "utf8")).toLowerCase().replace(/\s+/g, " ");
    const effective = /([^,(]+) as effective_units/.exec(sql);
    const total = /([^,(]+) as total_qty/.exec(sql);
    assert.ok(effective, `${newest}: ${writer} must name an effective_units expression`);
    assert.ok(total, `${newest}: ${writer} must name a total_qty expression`);
    assert.equal(
      effective[1].trim(),
      total[1].trim(),
      `${newest}: ${writer} computes effective_units and total_qty differently, so they are no longer ` +
        "interchangeable — Territory Management reads total_qty on the strength of them being equal " +
        "(tests/territory-units-closing-basis.test.ts), and that decision must be re-taken, not inherited",
    );
  }
}
