import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { RESTRICTED_PRODUCT_CODES } from "../src/lib/sales/access-scope.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// phx_closing_distributor_product used to re-derive its whole aggregate on every call: an Index-Only
// Scan of source_of_sales_fact_rollup (join to validated batches, factory-price join, and a
// per-(distributor, region, area, product) aggregate) — ~166 ms per call, all from cache, and the
// rpcAll() pager RE-RUNS it once per 1000-row page (2-3x for a real line). It feeds the Closing
// Comparison report AND the Monthly-Closing matrix (which now derives from it). Migration
// 20260815160000 precomputes exactly that fact-only work into source_of_sales_distributor_product_rollup
// (one row per batch × distributor × region × area × product, carrying Σ total_qty and Σ effective_units)
// and rewrites the function to read it.
//
// The one invariant this fix hinges on that the channel rollup did NOT: factory_price stays JOINED
// LIVE. The rollup bakes UNITS, never money, so the owner's rule — editing a product's factory price
// reprices all history instantly — is preserved. Value is price × Σ(effective_units), and because
// every row in a (distributor, region, area, product) group shares one product_code, that equals the
// live Σ(effective_units × price) to the piastre.
//
// The equivalence was PROVEN empirically on staging (Phoenix-HR-Staging, cifwmndunmlxjhyjugxa): the
// rollup-reading function vs the pre-rewrite live body, EXCEPT-diffed both directions over every
// (line, period) slice = zero rows different (20 slices, 10,300 rows each side), units/value to the
// piastre. A live-DB diff cannot run in CI, so this test is the in-repo backstop: it pins the SQL
// properties that MAKE that equivalence hold, so a later edit cannot quietly break one and move money.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MIGRATION_NAME = "20260815160000_closing_distributor_product_rollup.sql";
const MIGRATION = path.join(process.cwd(), "supabase/migrations", MIGRATION_NAME);

// Strip line comments before matching: this migration's header quotes column names and formulas, so a
// raw text search would match the prose.
function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

// The body of one `create or replace function public.<name>` … `$function$;` block.
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `${name} is (re)created in the migration`);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, `${name} has a terminated body`);
  return sql.slice(start, end + "$function$;".length);
}

export function runClosingDistributorProductRollupEquivalenceTests() {
  const raw = readFileSync(MIGRATION, "utf8");
  const sql = strip(raw).toLowerCase();

  // The migration must actually be registered under its timestamped name, or none of the below runs
  // in production (and this guard silently protects nothing).
  const files = readdirSync(path.join(process.cwd(), "supabase/migrations"));
  assert.ok(files.includes(MIGRATION_NAME), `${MIGRATION_NAME} is present in supabase/migrations`);

  const read = functionBody(sql, "phx_closing_distributor_product");
  const refresh = functionBody(sql, "phx_refresh_sos_distributor_product_rollup");

  // ── A. The read hits the precomputed rollup and does NOT re-scan the fact table ──────────────────
  // The ~166 ms Index-Only Scan + validated-batch join + aggregate no longer runs per call. If any of
  // it reappears in the read, the latency win is gone and the read/refresh can drift apart.
  assert.ok(
    read.includes("source_of_sales_distributor_product_rollup"),
    "the rewritten phx_closing_distributor_product must read the precomputed rollup table",
  );
  for (const banned of [
    "source_of_sales_fact_rollup",
    "source_of_sales_import_batches",
    "source_of_sales_import_rows",
  ]) {
    assert.ok(
      !read.includes(banned),
      `phx_closing_distributor_product must not re-scan ${banned} — that work moved into the per-batch `
      + "refresh. Its return inside the read both loses the speedup and risks the read and the refresh "
      + "drifting apart",
    );
  }

  // ── B. factory_price stays LIVE in the read — the invariant that separates this from the channel ─
  // rollup. The rollup bakes UNITS only; the money is price × Σ(effective_units) computed at read
  // time. If a `value`/`price` column were baked into the table, a factory-price edit would stop
  // repricing history — the owner's rule. So: the read MUST join factory_price, and the table MUST
  // NOT carry a baked value or price column.
  assert.ok(
    /left join public\.source_of_sales_products p/.test(read)
      && /factory_price/.test(read),
    "the read must join source_of_sales_products for the LIVE factory_price — money is never baked, so "
    + "a price edit reprices all history",
  );
  const createTable = sql.slice(
    sql.indexOf("create table if not exists public.source_of_sales_distributor_product_rollup"),
    sql.indexOf(");", sql.indexOf("create table if not exists public.source_of_sales_distributor_product_rollup")),
  );
  assert.ok(createTable.length > 0, "the rollup table is created in the migration");
  for (const bakedMoney of ["factory_price", "value ", "value\n", "price"]) {
    assert.ok(
      !createTable.includes(bakedMoney),
      `the rollup table must NOT carry a baked ${bakedMoney.trim()} column — baking money would break `
      + "the owner's rule that editing a factory price reprices history. It stores eff_units; price is "
      + "applied live in the read",
    );
  }
  assert.ok(
    /eff_units\s+numeric/.test(createTable) && /units_qty\s+numeric/.test(createTable),
    "the rollup stores Σ effective_units (eff_units) and Σ total_qty (units_qty) — units, not money",
  );

  // ── C. The value formula is byte-equivalent: price × Σ(eff_units), grouped by product_code ───────
  // Within a (distributor, region, area, product) group every row shares one product_code, so
  // Σ(eff_units × price) = price × Σ(eff_units) = the live Σ(effective_units × price). The GROUP BY
  // MUST include product_code or that factoring no longer holds.
  assert.ok(
    /sum\(r\.eff_units\s*\*\s*coalesce\(p\.factory_price,\s*0\)\)\s+as value/.test(read),
    "value = Σ(eff_units × coalesce(factory_price,0)) — the live money formula, price applied live",
  );
  assert.ok(
    /sum\(r\.units_qty\)\s+as units/.test(read),
    "units = Σ(units_qty), the pre-summed Σ total_qty — the report's units measure",
  );
  assert.ok(
    /group by r\.distributor_code, r\.region_code, r\.area_code, r\.product_code/.test(read),
    "the read groups by (distributor, region, area, product) — matching the live grain, and the reason "
    + "price factors cleanly out of the value sum",
  );
  assert.ok(
    /max\(r\.product_name\)\s+as product_name/.test(read),
    "product_name is max(product_name), exactly as the live function resolved it",
  );

  // ── D. The read filters the slice with the SAME normalization the live function used ─────────────
  // Live filtered lower(btrim(official_line)) = lower(btrim(p_line)); the rollup stores that folded
  // key as line_key. A mismatch here selects the wrong (or no) slice.
  assert.ok(
    /where r\.period = p_period/.test(read) && /r\.line_key = lower\(btrim\(p_line\)\)/.test(read),
    "the read filters period = p_period AND line_key = lower(btrim(p_line)), matching the live filter",
  );

  // ── E. The refresh applies the SAME exclusions the live function applied — direct + restricted ───
  // Live excluded `not is_direct` and product_code not in RESTRICTED_PRODUCT_CODES, BEFORE grouping. A
  // drift here changes which rows exist, i.e. the money and the row set.
  assert.ok(
    /not coalesce\(f\.is_direct, false\)/.test(refresh),
    "the refresh must exclude direct rows (not coalesce(is_direct,false)) — the live function did",
  );
  const restrictedInSql = [...RESTRICTED_PRODUCT_CODES].map((c) => c.toLowerCase()).sort().join(",");
  const refreshExcludesRestricted = [...refresh.matchAll(/\(([^()]*?)\)/g)].some((m) => {
    const codes = [...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]).sort().join(",");
    return codes === restrictedInSql;
  });
  assert.ok(
    refreshExcludesRestricted && /not in \(/.test(refresh),
    `the refresh must exclude exactly the RESTRICTED_PRODUCT_CODES set `
    + `(${[...RESTRICTED_PRODUCT_CODES].join(", ")}) — the same codes the live function filtered out`,
  );
  assert.ok(
    /sum\(f\.total_qty\)\s+as units_qty/.test(refresh)
      && /sum\(f\.effective_units\)\s+as eff_units/.test(refresh),
    "the refresh bakes Σ total_qty and Σ effective_units — the two measures the read needs, units only",
  );

  // ── F. Per-batch keying: the batch owns its rows, cascade cleans superseded batches ──────────────
  assert.ok(
    /references public\.source_of_sales_import_batches\(id\) on delete cascade/.test(sql),
    "the rollup is keyed to its batch with ON DELETE CASCADE, so a superseded batch self-cleans "
    + "(exactly like source_of_sales_fact_rollup) and there is no cross-batch write race",
  );
  assert.ok(
    /delete from public\.source_of_sales_distributor_product_rollup where batch_id = p_batch_id/.test(refresh),
    "the refresh is delete-by-batch then reinsert — the batch owns exactly its own rows",
  );

  // ── G. The initial backfill runs BEFORE the lock guard is attached ───────────────────────────────
  const backfillAt = sql.indexOf("$backfill$");
  const firstTriggerAt = sql.indexOf("create trigger trg_lock_guard_ins");
  assert.ok(backfillAt > 0 && firstTriggerAt > 0, "the backfill block and the lock-guard triggers both exist");
  assert.ok(
    backfillAt < firstTriggerAt,
    "the one-time backfill must run before the lock-guard triggers attach, or a locked slice never gets "
    + "its initial rollup",
  );

  // ── H. The closing lock guards the new table too, on the same (period, official_line) key ────────
  const lockTriggers = (sql.match(/phx_reject_write_to_locked_closing\('period', 'official_line'\)/g) ?? []).length;
  assert.equal(
    lockTriggers,
    3,
    "insert/update/delete on the rollup must all be guarded by the monthly-closing lock, keyed on "
    + "(period, official_line) — a refresh of a locked slice is correctly rejected",
  );

  // ── I. The refresh is wired into EVERY server-side refresh path, always AFTER the fact rollup ─────
  // Staleness vector: a path that refreshes fact but not this rollup leaves the Comparison + Matrix
  // stale. And this rollup reads the fact rollup, so it must run after it.
  for (const fn of ["phx_finalize_sos_batch", "phx_sync_sos_run", "phx_backfill_sos_fact_rollup"]) {
    const body = functionBody(sql, fn);
    assert.ok(
      body.includes("phx_refresh_sos_distributor_product_rollup"),
      `${fn} must also refresh the distributor-product rollup, or its slices go stale`,
    );
    assert.ok(
      body.indexOf("phx_refresh_sos_fact_rollup") < body.indexOf("phx_refresh_sos_distributor_product_rollup"),
      `in ${fn}, the DP refresh must run AFTER the fact rollup it reads from`,
    );
  }

  // ── J. The four server-side trio call-sites each add the DP refresh, AFTER the trio ──────────────
  // The RPC refreshes are ordered in TypeScript; the DP call must follow the fact refresh it reads.
  const TS_SITES = [
    // normalizer/mapping.ts no longer hand-copies the chain: since the 23 Oct audit (P4-05) its
    // backfill runs `refreshBatchRollups` from customer-map.ts, pinned by
    // tests/sales-imports-audit-fixes.test.ts. customer-map.ts is checked here and carries the chain.
    "src/lib/sales/normalizer/customer-map.ts",
    "src/lib/sales/normalizer/service.ts",
    "src/lib/sales/monthly-distributor-import.ts",
  ];
  for (const rel of TS_SITES) {
    const body = readFileSync(path.join(process.cwd(), rel), "utf8");
    const dpAt = body.indexOf("phx_refresh_sos_distributor_product_rollup");
    const factAt = body.indexOf("phx_refresh_sos_fact_rollup");
    assert.ok(
      dpAt > 0,
      `${rel} must call phx_refresh_sos_distributor_product_rollup after its refresh trio, or imports `
      + "through this path leave the Comparison + Matrix stale",
    );
    assert.ok(
      factAt > 0 && factAt < dpAt,
      `${rel} must call the DP refresh AFTER the fact rollup, because it reads what the fact rollup wrote`,
    );
  }
}
