import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildProductPeriodPrices,
  type ProductPriceOverride,
} from "../src/lib/sales/product-period-price.ts";

// PERIOD-SCOPED FACTORY PRICES — owner instruction, 2026-09-28.
//
// Saginko was repriced to xfactory 170.52 / public 270 / pharmacy 209.52. The owner scoped the two
// halves differently and said so in one sentence: direct orders "starting from today", and "the
// sales and target of the retail to be adjusted from 1 October".
//
// The retail half could not simply be typed into the product master. The closing engine values
// EVERY month as `units x the CURRENT factory price`, so a flat edit would have restated Jan-Aug by
// +1,814,407 EGP — +194,852 on July and +177,101 on August, both published and locked. Hence an
// override table, a resolver, and 31 functions repointed at it.
//
// This test pins the three things that would fail silently:
//   1. the resolution rule, which must match public.phx_factory_price() exactly;
//   2. that the override row seeds the price and the date the owner actually gave;
//   3. that every function which turns units into EGP reads the resolver rather than the flat
//      price — because one that was missed keeps valuing October at 111.15 and nothing says so.

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);

const PRICE_TABLE_SQL = readFileSync(
  fileURLToPath(new URL("20260928184100_period_scoped_factory_prices.sql", MIGRATIONS)),
  "utf8",
);

// The repoint ships as ONE FILE PER FUNCTION, not a bundle. Several guards in this directory
// resolve "the newest migration that defines X" and then read that whole file, so bundling made one
// function's SQL answer for another's — tests/territory-units-effective failed on a
// `sum(f.total_qty) as units` belonging to phx_closing_brick, four functions away. Concatenated here
// because what this test asserts is a property of the set.
const REPOINT_FILES = readdirSync(fileURLToPath(MIGRATIONS))
  .filter((f) => f.endsWith("_reads_the_period_price.sql"))
  .sort();

const REPOINT_SQL = REPOINT_FILES.map((f) =>
  readFileSync(fileURLToPath(new URL(f, MIGRATIONS)), "utf8"),
).join("\n");

/** Every function the repoint migration replaces, by the name it is created under. */
const REPOINTED_FUNCTIONS = [
  "au.f_monthly_attribution",
  "au.f_monthly_attribution_pre_split",
  "au.f_monthly_attribution_reconcile",
  "au.f_sales_area_trend",
  "au.f_sales_brick_detail",
  "au.f_sales_source_breakdown",
  "au.f_sales_source_breakdown_detail",
  "au.f_sales_source_breakdown_line",
  "public.phx_monthly_closing_matrix",
  "public.phx_closing_brick",
  "public.phx_closing_channel_breakdown",
  "public.phx_closing_corrections",
  "public.phx_closing_customers",
  "public.phx_closing_distributor_product",
  "public.phx_closing_publication_snapshot",
  "public.phx_lock_monthly_closing",
  "public.phx_exec_brick",
  "public.phx_exec_customers",
  "public.phx_exec_distributor_product",
  "public.phx_exec_sos_trend",
  "public.phx_customer_directory",
  "public.phx_customer_sales",
  "public.phx_territory_area_pharmacies",
  "public.phx_sales_channels_by_rep",
  "public.phx_refresh_sos_channel_rollup",
  "public.phx_market_awareness_tracking",
  "public.phx_marketing_coverage_export_sales_detail",
  "public.phx_marketing_request_roi_actuals",
  "public.phx_marketing_request_sales_lines",
  "public.phx_marketing_roi_customer_dashboard",
  "public.phx_refresh_marketing_roi_facts",
];

function overrides(entries: Record<string, ProductPriceOverride[]>): Map<string, ProductPriceOverride[]> {
  return new Map(Object.entries(entries));
}

export function runProductPeriodPriceTests() {
  // ── 1. The resolution rule ─────────────────────────────────────────────────
  const base = new Map([
    ["SA001", 111.15], // Saginko, the one product with an override
    ["RO001", 60.7], // Royafloxacin, no override — must be untouched in every period
  ]);
  const prices = buildProductPeriodPrices(
    base,
    overrides({ SA001: [{ effectivePeriod: "2026-10", factoryPrice: 170.52 }] }),
  );

  // The boundary the owner drew, from both sides.
  assert.equal(prices.priceFor("SA001", "2026-09"), 111.15, "September is still the old price");
  assert.equal(prices.priceFor("SA001", "2026-10"), 170.52, "October is the new price");
  assert.equal(prices.priceFor("SA001", "2026-11"), 170.52, "and it holds after October");
  assert.equal(prices.priceFor("SA001", "2026-07"), 111.15, "July — published — must not move");
  assert.equal(prices.priceFor("SA001", "2026-08"), 111.15, "August — published — must not move");
  assert.equal(prices.priceFor("SA001", "2025-12"), 111.15, "a period before any data is the old price");
  assert.equal(prices.priceFor("SA001", "2027-03"), 170.52, "and a period far ahead is the new one");

  // A product with no override is valued exactly as it always was — the owner's 2026-08-14 policy,
  // which this change narrows rather than replaces.
  for (const period of ["2026-01", "2026-09", "2026-10", "2027-06"]) {
    assert.equal(prices.priceFor("RO001", period), 60.7, `RO001 is unaffected in ${period}`);
  }

  // A blank period falls back to the master price, matching what the SQL resolver returns when
  // `effective_period <= null` matches no row.
  assert.equal(prices.priceFor("SA001", null), 111.15, "null period falls back to the master price");
  assert.equal(prices.priceFor("SA001", undefined), 111.15, "so does undefined");
  assert.equal(prices.priceFor("SA001", "  "), 111.15, "so does a blank string");
  assert.equal(prices.currentPrice("SA001"), 111.15, "currentPrice is always the master price");

  // Case and padding come from callers all over the app; the SQL side upper/btrims both columns.
  assert.equal(prices.priceFor(" sa001 ", "2026-10"), 170.52, "the code is trimmed and upper-cased");

  // An unknown product resolves to null rather than 0, so a caller's `?? 0` stays its own decision.
  assert.equal(prices.priceFor("ZZ999", "2026-10"), null, "an unknown product has no price");

  // Several overrides on one product: the LAST one that has started wins, never the newest row.
  const laddered = buildProductPeriodPrices(
    base,
    overrides({
      SA001: [
        { effectivePeriod: "2027-01", factoryPrice: 200 },
        { effectivePeriod: "2026-10", factoryPrice: 170.52 },
      ],
    }),
  );
  assert.equal(laddered.priceFor("SA001", "2026-09"), 111.15, "before the first override");
  assert.equal(laddered.priceFor("SA001", "2026-12"), 170.52, "between two overrides, the earlier one");
  assert.equal(laddered.priceFor("SA001", "2027-01"), 200, "on the later override's own month");

  // ── 2. The seed row says what the owner said ───────────────────────────────
  assert.match(
    PRICE_TABLE_SQL,
    /'SA001',\s*'2026-10',\s*170\.52,\s*270,\s*209\.52/,
    "the override seeds SA001 at 170.52/270/209.52 from 2026-10, the owner's own figures and date",
  );
  assert.ok(
    /create table if not exists public\.source_of_sales_product_price_history/i.test(PRICE_TABLE_SQL),
    "the override table is created in the migration, not by hand on a database",
  );
  assert.ok(
    /revoke execute on function public\.phx_factory_price\(text, text\) from public, anon, authenticated/i
      .test(PRICE_TABLE_SQL),
    "the resolver is a public SECURITY DEFINER function and must not be callable with the anon key",
  );
  assert.ok(
    /enable row level security/i.test(PRICE_TABLE_SQL),
    "the override table has RLS on, like the rest of the sales master data",
  );

  // ── 3. Every money function reads the resolver ─────────────────────────────
  assert.equal(
    REPOINT_FILES.length,
    REPOINTED_FUNCTIONS.length,
    `one migration per repointed function — found ${REPOINT_FILES.length} files for ${REPOINTED_FUNCTIONS.length} functions`,
  );
  for (const fn of REPOINTED_FUNCTIONS) {
    // Case-insensitive, but the files are lowercase on purpose: tests/au-seat-occupant-resolver
    // extracts a function body behind `kind === "function"`, a case-SENSITIVE compare against its
    // own regex capture, so an uppercase `CREATE` there silently cuts the body at the first
    // semicolon and makes the rest of the function invisible to that guard.
    const created = new RegExp(`create or replace function ${fn.replace(".", "\\.")}\\(`, "i").test(REPOINT_SQL);
    assert.ok(created, `${fn} must be repointed by the migration`);
    assert.ok(
      REPOINT_SQL.includes(`create or replace function ${fn}(`),
      `${fn} must be declared in lowercase, or the seat-occupant guard reads a truncated body`,
    );
  }

  // The body of the migration must contain no surviving read of the flat master price in a VALUE
  // expression. This is the assertion that catches the one real failure mode: a function left
  // behind still values October at 111.15, and no screen, test or error says so.
  const flatPriceInAValue = REPOINT_SQL.split("\n").filter((line) =>
    /\*\s*coalesce\([a-z]+\.factory_price/i.test(line),
  );
  assert.deepEqual(
    flatPriceInAValue,
    [],
    "no repointed function may still multiply units by the product master's flat factory_price",
  );

  // Each repointed function should call the resolver at least as many times as it valued a row.
  const resolverCalls = REPOINT_SQL.split("public.phx_factory_price(").length - 1;
  assert.ok(
    resolverCalls >= REPOINTED_FUNCTIONS.length,
    `expected at least one resolver call per repointed function, found ${resolverCalls}`,
  );

  // ── 4. The direct-order rule is untouched ──────────────────────────────────
  // The factory price is BANNED from the Direct Orders module entirely (owner, 2026-08-04, stated
  // four times), and the direct-order half of this repricing moved the PUBLIC and PHARMACY prices
  // on the product master instead — which direct orders snapshot onto the request at submit.
  //
  // Two of the repointed functions legitimately READ `direct_order_requests` (the closing's
  // correction and territory surfaces join approved orders), so the assertion is not "never
  // mentions it". It is that this migration never WRITES to it, and never touches the two snapshot
  // columns that carry a submitted order's agreed price.
  const writesToDirectOrders =
    /\b(insert\s+into|update|delete\s+from)\s+(public\.)?direct_order_requests\b/i.test(REPOINT_SQL);
  assert.equal(writesToDirectOrders, false, "the repoint migration must not write to direct orders");
  assert.ok(
    !/\b(public|pharmacy)_price_snapshot\b/i.test(REPOINT_SQL),
    "a submitted order's snapshotted public/pharmacy price is never re-derived from anything here",
  );
}
