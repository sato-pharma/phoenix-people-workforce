import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The two hottest sales functions must resolve the factory price ONCE PER PRODUCT, never once per
 * fact row.
 *
 * 🔴 WHAT THIS COST, 2026-09-28. `source_of_sales_product_price_history` gained its first row at
 * 15:59:48 UTC (the Saginko retail repricing) and `public.phx_factory_price(code, period)` began
 * being called per sales row by 31 functions. Measured from the 50 days of history in
 * `public.pg_stat_statements_snapshots`:
 *
 *     phx_sales_vs_target_range    241 ms -> 1,067 -> 1,952
 *     phx_closing_customers        685 ms ->   888 -> 2,739
 *     phx_monthly_attribution      709 ms ->   884 -> 4,366
 *     crm_contact_master_refresh   612 ms ->   630 ->   708   (control: not sales, stayed flat)
 *
 * The control is what proves it was the sales path and not the database.
 *
 * 🔴 TWO OBVIOUS FIXES WERE MEASURED AND BOTH FAILED, which is why this test pins the shape rather
 * than the function's flags. Writing the same logic out by hand — i.e. what Postgres would do if
 * the function were made inlinable by dropping SECURITY DEFINER and SET search_path — ran in
 * 1,332 ms against the original 1,374 ms. Adding indexes on `upper(btrim(product_code))` to both
 * source tables ran in 1,320 ms. The cost is the per-row correlated subqueries themselves, not the
 * function-call overhead, so ONLY hoisting the lookup out of the row loop works: 140 ms.
 *
 * Everything below is checkable with no database.
 */
export function runFactoryPriceResolvedOnceTests() {
  const migrations = [
    "20260929185741_closing_customers_price_once_per_product.sql",
    "20260929190322_monthly_attribution_price_once_per_product.sql",
  ];

  // Comments legitimately name phx_factory_price — the headers explain the whole incident. Only
  // executable SQL counts, so strip comments the same way check-sql-backup-placement.ts does.
  const stripComments = (sql: string) =>
    sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

  for (const file of migrations) {
    const raw = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
    const sql = stripComments(raw);

    // 1. THE HOISTED LOOKUP EXISTS.
    assert.match(
      sql,
      /with\s+price\s+as\s*\(/i,
      `${file}: the price must be resolved in a CTE, once per product`,
    );

    // 2. AND NOTHING CALLS IT PER ROW ANY MORE. This is the assertion that fails if someone
    //    "simplifies" the CTE back into the expression it replaced.
    assert.ok(
      !/phx_factory_price\s*\(/i.test(sql),
      `${file}: phx_factory_price(...) must not be called in executable SQL here — it is a per-row `
        + `call inside an aggregate, which is the whole regression. Resolve it in the price CTE.`,
    );

    // 3. THE ARITHMETIC IS STILL phx_factory_price's: the dated override first, ordered newest
    //    first and limited to one, then the master price as the fallback. A CTE that dropped the
    //    history lookup would be fast and WRONG — it would silently ignore the Saginko override.
    assert.match(sql, /source_of_sales_product_price_history/i, `${file}: the override must still be read`);
    assert.match(sql, /effective_period\s*<=\s*p_period/i, `${file}: the override must be period-bounded`);
    assert.match(sql, /order\s+by\s+h\.effective_period\s+desc/i, `${file}: newest applicable override wins`);
    assert.match(sql, /source_of_sales_products/i, `${file}: the master price must remain the fallback`);

    // 4. The join key must be the folded code, or the lookup silently misses and prices go to zero.
    assert.match(sql, /upper\(btrim\(pr\.product_code\)\)\s+as\s+code/i, `${file}: the CTE keys on the folded code`);
  }

  // ---------------------------------------------------------------- negative controls

  // Without these, a file that simply lost its price logic entirely would pass everything above.
  const perRowBody = `
    with agg as (
      select sum(f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)) as value
      from public.source_of_sales_fact_rollup f
    ) select * from agg;`;
  assert.ok(
    /phx_factory_price\s*\(/i.test(stripComments(perRowBody)),
    "the per-row detector must fire on the shape it exists to catch",
  );

  const commentOnly = `-- phx_factory_price(code, period) is what this replaces\nwith price as (select 1);`;
  assert.ok(
    !/phx_factory_price\s*\(/i.test(stripComments(commentOnly)),
    "a mention in a comment must NOT be read as a call — the headers explain the incident",
  );

  const fastButWrong = `with price as (select upper(btrim(pr.product_code)) as code, pr.factory_price
                       from public.source_of_sales_products pr)`;
  assert.ok(
    !/source_of_sales_product_price_history/i.test(stripComments(fastButWrong)),
    "a CTE that skipped the override must be detectable — fast and wrong is the dangerous outcome",
  );
}
