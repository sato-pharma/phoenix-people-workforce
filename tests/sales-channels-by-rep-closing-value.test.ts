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

// A CTE named once is inlined, and its expression is copied into every place that reads the column.
// `rp.channel` is read by six FILTERs, so the classifier ran six times a row: 140,538 calls for 23,423
// rows in one month, 32.9 s of 34.1 s (staging, 2026-11-01). Rows equal on these six columns are one
// row to the classifier and the seat join, so each group is classified once. Drop a column from the
// GROUP BY and two different answers are merged into one, which is why the whole list is pinned.
const CLASSIFIED_GROUP =
  "from rows_in_scope t group by t.client_name, t.client_code, t.distributor_code, t.invoice_period, t.official_line, t.area_code";

function assertClassifiedOnce(body: string, file: string): void {
  assert.ok(
    body.includes("tagged as materialized ("),
    `RED Channels by Rep must keep its classifying CTE MATERIALIZED, or the call is copied into all six FILTERs (${file})`,
  );
  assert.ok(
    body.includes("from grouped t cross join rule"),
    `RED Channels by Rep must classify the grouped rows, not every import row (${file})`,
  );
  assert.ok(
    body.includes(CLASSIFIED_GROUP),
    `RED Channels by Rep must group on every column the classifier and the seat join read (${file})`,
  );
  assert.equal(
    body.split("public.phx_customer_channel(").length - 1,
    1,
    `RED Channels by Rep must name the classifier exactly once (${file})`,
  );
}

// phx_squash_customer_name is replace(fold(name), ' ', ''), so calling it re-folded a name the
// classifier had just folded: half of what a call cost. The search_path is written out because it
// came from an ALTER (20260929215727), so a CREATE OR REPLACE without it silently removes it.
function assertClassifierFoldsOnce(definition: string, file: string): void {
  assert.ok(
    definition.includes("v_squashed text := replace(v_spaced, ' ', '')"),
    `RED phx_customer_channel must squash the name it already folded (${file})`,
  );
  assert.equal(
    definition.split("phx_fold_customer_name(").length - 1,
    1,
    `RED phx_customer_channel must fold each name once (${file})`,
  );
  assert.ok(
    !definition.includes("phx_squash_customer_name("),
    `RED phx_customer_channel must not fold the name a second time through phx_squash_customer_name (${file})`,
  );
  assert.ok(
    definition.includes("set search_path to 'public', 'pg_temp'"),
    `RED phx_customer_channel must keep its pinned search_path (${file})`,
  );
}

/** Everything from the CREATE up to the closing $function$, lower-cased and on one line. */
function newestDefinition(name: string): { definition: string; file: string } {
  const { file } = newestBody(name);
  const sql = stripSqlComments(readFileSync(path.join(MIGRATIONS, file), "utf8"));
  const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i"));
  const open = sql.indexOf("$function$", start);
  const close = sql.indexOf("$function$", open + "$function$".length);
  return { definition: sql.slice(start, close).toLowerCase().replace(/\s+/g, " "), file };
}

export function runSalesChannelsByRepClosingValueTests() {
  const { body, file } = newestBody("phx_sales_channels_by_rep");

  assertClassifiedOnce(body, file);
  const brokeOnce = (nextBody: string, expect: RegExp) => {
    assert.throws(() => assertClassifiedOnce(nextBody, file), expect);
  };
  brokeOnce(body.replace("tagged as materialized (", "tagged as ("), /keep its classifying CTE MATERIALIZED/);
  brokeOnce(body.replace("from grouped t cross join rule", "from rows_in_scope t cross join rule"), /classify the grouped rows/);
  brokeOnce(body.replace(CLASSIFIED_GROUP, CLASSIFIED_GROUP.replace("t.invoice_period, ", "")), /every column the classifier/);
  brokeOnce(`${body} public.phx_customer_channel(`, /name the classifier exactly once/);

  const classifier = newestDefinition("phx_customer_channel");
  assertClassifierFoldsOnce(classifier.definition, classifier.file);
  const brokeFold = (nextDefinition: string, expect: RegExp) => {
    assert.throws(() => assertClassifierFoldsOnce(nextDefinition, classifier.file), expect);
  };
  brokeFold(
    classifier.definition.replace("v_squashed text := replace(v_spaced, ' ', '')", "v_squashed text := public.phx_squash_customer_name(p_client_name)"),
    /squash the name it already folded/,
  );
  brokeFold(`${classifier.definition} public.phx_fold_customer_name(p_client_name)`, /fold each name once/);
  brokeFold(`${classifier.definition} public.phx_squash_customer_name(p_client_name)`, /through phx_squash_customer_name/);
  brokeFold(classifier.definition.replace("set search_path to 'public', 'pg_temp'", ""), /keep its pinned search_path/);

  // Above what the whole history takes, so its answer reaches the tab before the client gives up.
  assert.ok(
    SRC.includes("getSupabaseAdmin({ requestTimeoutMs: CHANNELS_BY_REP_REQUEST_TIMEOUT_MS })"),
    "Channels by Rep must read through its own request budget: the default 15 s is shorter than the whole history takes",
  );

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
