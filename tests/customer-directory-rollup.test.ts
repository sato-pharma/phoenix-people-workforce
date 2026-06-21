import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runCustomerDirectoryRollupTests() {
  const migration = read("../supabase/migrations/20260621260000_customer_directory_rollup.sql");
  assert.match(
    migration,
    /create table if not exists public\.source_of_sales_customer_directory_rollup/,
    "customer directory rollup table must exist",
  );
  assert.match(
    migration,
    /create or replace function public\.phx_refresh_sos_customer_directory_rollup/,
    "per-batch customer directory refresh function must exist",
  );
  assert.match(
    migration,
    /create or replace function public\.phx_backfill_sos_customer_directory_rollup/,
    "backfill function must exist for production rollout",
  );
  assert.match(
    migration,
    /from public\.source_of_sales_customer_directory_rollup c/,
    "customer directory RPC must read the cached rollup instead of live-scanning raw rows",
  );
  assert.match(
    migration,
    /c\.effective_units \* coalesce\(p\.factory_price, 0\) as line_value/,
    "customer directory totals must keep live factory pricing",
  );

  const importer = read("../src/lib/sales/monthly-distributor-import.ts");
  assert.match(
    importer,
    /phx_refresh_sos_customer_directory_rollup/,
    "coded Source of Sales imports must refresh the customer directory rollup",
  );

  const normalizer = read("../src/lib/sales/normalizer/service.ts");
  assert.match(
    normalizer,
    /phx_refresh_sos_customer_directory_rollup/,
    "normalizer imports must refresh the customer directory rollup",
  );
}
