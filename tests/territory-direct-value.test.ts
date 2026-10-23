import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Territory Management's area pharmacies list (phx_territory_area_pharmacies) must value a direct
// order as it is from the source — source_of_sales_customer_directory_rollup.direct_value — and
// never as units × factory price (owner rule, locked 2026-08-04, restated 2026-09-05). Until
// 20260921091500 it priced every row at factory, overstating Aug 2026 direct sales by 21,556.48 EGP
// and Sep 2026 by 31,273.80. The pin reads the NEWEST migration that defines the function, so a
// later rewrite that drops the direct branch goes red here.

function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

export function runTerritoryDirectValueTests() {
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
    newest >= "20260921091500_territory_area_pharmacies_direct_value.sql",
    `the newest definition of phx_territory_area_pharmacies (${newest}) predates the direct-value fix`,
  );

  const sql = strip(readFileSync(path.join(migDir, newest), "utf8")).toLowerCase().replace(/\s+/g, " ");

  // The price SOURCE moved on 2026-09-28: a factory price can differ by period (Saginko is 111.15
  // through 2026-09 and 170.52 from 2026-10), so the body may read `p.factory_price` or
  // `public.phx_factory_price(code, period)`, which resolves an override and falls back to that
  // same master price. What this pins is the SPLIT, not the source — a direct order takes
  // `direct_value`, and only a non-direct row is priced at all — so both spellings satisfy it and
  // the negative below rejects both.
  // And once more on 2026-10-23, for SPEED: phx_factory_price is SECURITY DEFINER and carries a SET,
  // so Postgres cannot inline it and every row-level mention was a real call with two correlated
  // subqueries. It is now resolved once per distinct (product_code, period) in a `period_price` CTE
  // and left-joined, so the body may also read `<alias>.period_price`. Same number for the same row,
  // proven on production over all 262,293 directory rows; the SPLIT this pins is untouched, and the
  // negative below rejects this spelling too.
  const PRICE = String.raw`coalesce\((?:p\.factory_price|public\.phx_factory_price\([^)]*\)|[a-z_]+\.period_price), 0\)`;

  // The UNIT column moved on 2026-10-02, for the same reason the price source moved before it. The
  // function read `effective_units` on the belief that it is the credited-to-area basis produced by
  // El Qema's warehouse bands and the city rule. It is not: both writers of the rollup compute
  // `sum(coalesce(r.qty, 0))` for `effective_units` AND for `total_qty`, so the two are identical by
  // construction, and the only 41 rows that ever differed carried a distributor's own trade discount
  // in the PACK count — which left this page 20% under the published closing on El Qema's August.
  // So the body may read either column. What this pins is still the SPLIT — a direct order takes
  // `direct_value`, and only a non-direct row is priced at all — and the negative below rejects BOTH
  // spellings, so a migration that prices every row at factory goes red whichever column it names.
  const UNITS = String.raw`r\.(?:effective_units|total_qty)`;

  assert.ok(
    new RegExp(
      String.raw`case when r\.is_direct then coalesce\(r\.direct_value, 0\) else ${UNITS} \* ${PRICE} end`,
    ).test(sql),
    `${newest}: a direct order must take its source value (direct_value), never units × factory price — ` +
      "the Territory Management pharmacies list overstated direct sales by 7-9% while it did",
  );
  assert.ok(
    !new RegExp(String.raw`,\s*${UNITS} \* ${PRICE} as row_value`).test(sql),
    `${newest}: every row, direct ones included, is priced at factory again`,
  );
  assert.ok(
    sql.includes("on upper(btrim(p.product_code)) = upper(btrim(r.product_code))"),
    `${newest}: the product-master join must be normalised on both sides, as in its sibling RPCs`,
  );
}
