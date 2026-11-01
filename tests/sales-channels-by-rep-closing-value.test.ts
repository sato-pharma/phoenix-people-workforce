import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Channels by Rep values a sale the way the monthly closing does.
//
// A distributor row is worth its paid units x the product's factory price, and a direct order keeps
// its own order value. That is the owner's rule of 2026-09-07 ("we take the units and multiply by
// factory"), and his decision of 2026-09-18 ("make Channels by Rep use the closing's value").
// Channels by Rep used to add up the `value` column each distributor typed into its own sheet, the
// one surface left on it. Source of Sales audit, finding `src/lib/sales/channels-by-rep.ts:178`
// (high), still open on the 2026-09-06 re-measure.
//
// Production on 2026-09-18, restricted products stripped: El Qema's August Pedia sheet, 8,768 paid
// units, read 1,888,898.40 EGP here and 2,367,360.00 in the closing. Their sheet carries the invoice
// at 79.8% of list. The tab moved +478,370.20 EGP for August and +178,228.19 for April (RM's discount
// column), and direct orders moved by nothing.
//
// Bonus is never counted. `qty` holds paid units only, and no distributor row on production has ever
// stored a bonus unit. The only bonus units sit on direct-order rows, which keep their order value.
//
// The value lives in SQL, so this reads the body Postgres runs: the one from the newest migration
// that defines each function. A later migration that puts the sheet value back fails here.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");

/** The body of the newest migration that (re)defines `name`, lower-cased and on one line. */
function newestBody(name: string): { body: string; file: string } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const defines = new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i");
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const sql = stripSqlComments(readFileSync(path.join(MIGRATIONS, files[i]), "utf8"));
    const at = sql.search(defines);
    if (at === -1) continue;
    const start = sql.indexOf("$function$", at);
    const end = sql.indexOf("$function$", start + "$function$".length);
    assert.ok(start !== -1 && end > start, `${files[i]} has a terminated body for ${name}`);
    return { body: sql.slice(start, end).toLowerCase().replace(/\s+/g, " "), file: files[i] };
  }
  throw new Error(`no migration defines public.${name}`);
}

const SRC = readFileSync(path.join(process.cwd(), "src/lib/sales/channels-by-rep.ts"), "utf8");

// Staging, 2026-11-01, the pricing alone over the whole history: 8,043 ms and 29,849,634 rows removed
// by the two "is not distinct from" that used to join the lookup, 2,365 ms on one concatenated key,
// the same 70984571.286685 over the same 168,642 rows. Neither enable_nestloop nor a better estimate
// can help the old shape: that operator cannot hash or merge.
function assertPriceJoinCanHash(body: string, file: string): void {
  assert.ok(
    body.includes("left join period_price pp on pp.pair = r.product_code || '|' || r.invoice_period"),
    `RED Channels by Rep must join the price lookup on one concatenated key, which can hash (${file})`,
  );
  assert.ok(
    !/pp\.[a-z_]+ is not distinct from/.test(body),
    `RED Channels by Rep must not join the price lookup with "is not distinct from", which cannot hash (${file})`,
  );
  assert.ok(
    /<> all \(array\( ?select upper\(btrim\(code\)\) from unnest\(coalesce\(p_excluded_product_codes, '\{\}'\)\) code ?\)\)/.test(body),
    `RED Channels by Rep must test its excluded codes through array( … ), resolved once per call: a bare sublink ran 47,769 times (${file})`,
  );
}

export function runSalesChannelsByRepClosingValueTests() {
  const { body, file } = newestBody("phx_sales_channels_by_rep");

  assertPriceJoinCanHash(body, file);
  const broke = (nextBody: string, expect: RegExp) => {
    assert.throws(() => assertPriceJoinCanHash(nextBody, file), expect);
  };
  broke(
    body.replace(
      "on pp.pair = r.product_code || '|' || r.invoice_period",
      "on pp.product_code is not distinct from r.product_code and pp.invoice_period is not distinct from r.invoice_period",
    ),
    /one concatenated key/,
  );
  broke(body.replace("where (p_period is null", "where pp.pair is not distinct from r.product_code and (p_period is null"), /must not join the price lookup/);
  broke(body.replace("<> all (array(", "<> all (("), /through array\( … \)/);

  // ── The headline: a distributor row is paid units x factory price, a direct order its own value ──
  //
  // The price SOURCE moved on 2026-09-28: a factory price can differ by period (Saginko is 111.15
  // through 2026-09 and 170.52 from 2026-10), so the body may read `p.factory_price` or
  // `public.phx_factory_price(code, period)` — the resolver, which falls back to that same master
  // price when no override covers the period. Either keeps what this pins: a distributor row is
  // paid units x a factory price, and only a direct order reads the sheet's typed value. The
  // `coalesce(r.value, 0)` count below is what stops the sheet value creeping back, and the live
  // product-master join is still asserted a few lines down.
  //
  // It moved once more on 2026-10-23, and for SPEED, not for the rule: phx_factory_price is SECURITY
  // DEFINER and carries a SET, so Postgres cannot inline it and every row-level mention was a real
  // call with two correlated subqueries. The resolver is now called once per distinct
  // (product_code, invoice_period) in a `period_price` CTE and left-joined, so the body may also read
  // `<alias>.period_price`. It resolves the same number for the same row — proven on production over
  // all 405,724 import rows, 0 mismatches — and the direct arm below is untouched.
  assert.match(
    body,
    /case when coalesce\(r\.is_direct, false\) then coalesce\(r\.value, 0\) else coalesce\(r\.qty, 0\) \* coalesce\((?:p\.factory_price|public\.phx_factory_price\([^)]*\)|[a-z_]+\.period_price), 0\) end as value/,
    `Channels by Rep must value a distributor row at paid units x factory price and a direct order at its own value, as the closing does (${file})`,
  );
  assert.equal(
    body.split("coalesce(r.value, 0)").length - 1,
    1,
    "the sheet's typed value is read once, for a direct order only, never for a distributor row",
  );
  assert.match(
    body,
    /left join public\.source_of_sales_products p on upper\(btrim\(p\.product_code\)\) = upper\(btrim\(r\.product_code\)\)/,
    "the factory price comes from the live product master, so a price edit reprices this tab with the closing",
  );
  assert.ok(!body.includes("bonus"), "bonus units never add to units or value");

  // ── The same rule as the closing it is compared with ─────────────────────────────────────────
  const closing = newestBody("phx_closing_distributor_product").body;
  assert.match(closing, /factory_price/, "the closing prices distributor sales at factory price");
  const direct = newestBody("phx_monthly_closing_direct").body;
  assert.match(direct, /direct_value/, "the closing keeps a direct order's own value");

  // ── The tab still reads this function ────────────────────────────────────────────────────────
  assert.ok(
    SRC.includes('supabase.rpc("phx_sales_channels_by_rep"'),
    "Channels by Rep must read phx_sales_channels_by_rep, or the value rule above protects nothing",
  );
}
