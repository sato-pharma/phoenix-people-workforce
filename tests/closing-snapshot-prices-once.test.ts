import assert from "node:assert/strict";

import { liveFunctionBody } from "./support/sql-definer.ts";

/**
 * THE PUBLISHED-CLOSING SNAPSHOT RESOLVES EACH PRODUCT'S PRICE ONCE, NOT ONCE PER ROW.
 *
 * `phx_closing_publication_snapshot` is both halves of "has a published month moved": the
 * publish-time trigger stores its output as the baseline, and `phx_closing_publication_drift`
 * compares today's output against that stored copy. The Needs You board's "Published closings that
 * have moved" source reads it once per published line, inside ONE 8-second budget.
 *
 * It timed out on 12 of the 15 mornings 9-23 Oct 2026 — the second worst of eleven sources, counted
 * from the delivered digests in `notification_events.metadata`. By then the two obvious narrowings
 * were already in place: the source reads only the LATEST published period, and
 * `20261023084810` had cut three snapshot recomputes per line down to one. Measured on production
 * 2026-10-23, CNS 2026-09:
 *
 *     the snapshot                                  1,645 ms   38,963 shared buffers
 *     the same query without the `value` aggregate     177 ms        702 shared buffers
 *
 * All of it was one expression: `phx_factory_price(f.product_code, f.period)` evaluated once per
 * rollup row — 18,558 times, to resolve 15 distinct products. It is a SQL function the planner would
 * normally inline into a join, and it cannot, because it is SECURITY DEFINER. Resolving the price
 * once per DISTINCT product code took the same call to 241 ms over 969 buffers, and the board's whole
 * three-line read to 747 ms.
 *
 * Source-level on purpose, and against the LAST migration to define the function rather than a path:
 * a pin that names a file reads dead SQL the moment a later migration redefines the same body.
 *
 * Two things here are easy to "fix" back into the slow shape, which is why each is its own assertion:
 *
 *   1. MOVING THE RESOLVER BACK INSIDE THE VALUE EXPRESSION. It reads more naturally there — the
 *      price belongs to the row being valued — and it is the whole 1.6 seconds.
 *   2. RE-ADDING THE `source_of_sales_products` JOIN. It was load-bearing until 2026-09-28, when
 *      `p.factory_price` was replaced by the resolver, and it has been pure cost since. A LEFT JOIN
 *      fans out on duplicates, so two master rows differing only in case or padding would multiply
 *      that product's units — a published month restated by a join nobody reads. Production holds no
 *      such duplicates today, which is what makes it latent rather than live.
 *
 * The third assertion is the one that protects a number rather than a latency: the price must still
 * come from `phx_factory_price`, never the product master's flat `factory_price` column. Saginko
 * (SA001) is 111.15 through 2026-09 and 170.52 from 2026-10, and reading the flat column would
 * restate Jan-Aug by +1,814,407 EGP, +194,852 of it on PUBLISHED July.
 */
export function runClosingSnapshotPricesOnceTests() {
  const body = liveFunctionBody("phx_closing_publication_snapshot");

  // ── 1. The resolver is called once, and before the per-row value expression ────────────────
  const calls = body.split("phx_factory_price(").length - 1;
  assert.equal(
    calls,
    1,
    `phx_closing_publication_snapshot calls phx_factory_price ${calls} times — it must be called ` +
      "exactly once, from a CTE keyed on the distinct product codes. The function is SECURITY " +
      "DEFINER, so the planner cannot inline it: every call in a row-level expression is a real " +
      "invocation, and that cost 1,645 ms and 38,963 buffers for one line of one month.",
  );

  const cellsAt = body.indexOf("cells as (");
  assert.ok(cellsAt > 0, "expected the snapshot to still build its per-cell aggregate in a `cells` CTE");

  const callAt = body.indexOf("phx_factory_price(");
  assert.ok(
    callAt < cellsAt,
    "phx_factory_price is called at or after the `cells` CTE — i.e. once per ROW being valued. It " +
      "must be resolved before it, once per product, or the Needs You publication-drift source " +
      "spends most of its 8-second budget on 18,558 invocations that answer 15 questions.",
  );

  assert.match(
    body.slice(0, cellsAt),
    /select distinct\s+\w+\.product_code/,
    "the price CTE must be keyed on `select distinct <alias>.product_code` — resolving per distinct " +
      "product is the whole fix, and the period argument is already constant across the scan",
  );

  const cellsBlock = body.slice(cellsAt);
  assert.ok(
    !cellsBlock.includes("phx_factory_price("),
    "the per-cell value expression must read a resolved price column, never call the resolver itself",
  );
  assert.match(
    cellsBlock,
    /effective_units \* coalesce\(\w+\.period_price, 0\)/,
    "a non-direct cell's value must be `effective_units * coalesce(<alias>.period_price, 0)` — the " +
      "column is called period_price, deliberately not factory_price, because " +
      "source_of_sales_products has a column of that name holding the FLAT master price and the two " +
      "must stay unmistakable",
  );

  // ── 2. The dead join stays gone ────────────────────────────────────────────────────────────
  assert.ok(
    !/join\s+source_of_sales_products/i.test(body),
    "the snapshot must not join source_of_sales_products. It lost its only consumer on 2026-09-28 " +
      "and a LEFT JOIN fans out on duplicate product codes, which would multiply a published " +
      "month's units for that product.",
  );

  // ── 3. The period price, never the flat master price ───────────────────────────────────────
  assert.ok(
    body.includes("public.phx_factory_price("),
    "the price must still be resolved through public.phx_factory_price(product_code, period) — it is " +
      "what makes Saginko 111.15 through 2026-09 and 170.52 from 2026-10",
  );
  assert.ok(
    !/\*\s*coalesce\(\w+\.factory_price/.test(body),
    "the snapshot must never multiply units by the product master's flat factory_price: that values " +
      "every month at today's price and restates Jan-Aug by +1,814,407 EGP, two published months " +
      "among them",
  );

  // ── 4. The scan is still keyed on the period, which is what makes the price constant ───────
  assert.match(
    body,
    /where f\.period = p_period/,
    "the rollup scan must still filter on `f.period = p_period`. That predicate is the reason the " +
      "price can be resolved per product at all: it is what makes the resolver's period argument " +
      "constant for every row in the scan.",
  );
}
