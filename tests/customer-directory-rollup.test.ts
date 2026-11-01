import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

// The migration that LAST defines public.phx_customer_directory, from the function's opener on, so
// a later redefinition is held to the same rules and the file's own account of them is not read.
function lastDirectoryDefinition(): string {
  const opener = /create\s+or\s+replace\s+function\s+public\.phx_customer_directory\(/i;
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => opener.test(readFileSync(new URL(name, dir), "utf8")));
  assert.ok(files.length > 0, "no migration defines public.phx_customer_directory");
  const sql = readFileSync(new URL(files[files.length - 1], dir), "utf8").replace(/\r\n/g, "\n");
  return sql.slice(sql.search(opener)).replace(/\s+/g, " ").toLowerCase();
}

// /sales/customer-directory failed on 2026-11-01: 24,622 ms for one read against a 15,000 ms client.
function assertDirectoryCanAnswerInTime(definition: string, loader: string): void {
  assert.ok(
    definition.includes("set enable_nestloop to 'off'"),
    "RED phx_customer_directory must keep enable_nestloop off — planned with its parameters unknown it expects 24 rows out of about 118,000 and walks the whole price list for each one (20,384,417 rows removed by join filter on staging, 11,953 ms against 1,383 ms)",
  );
  assert.ok(
    /<> all \(array\( ?select upper\(btrim\(x\)\) from unnest\(coalesce\(p_exclude_codes, '\{\}'::text\[\]\)\) as x ?\)\)/.test(definition),
    "RED phx_customer_directory must test p_exclude_codes through array( … ), resolved once per call — a bare sublink runs again for every row",
  );

  const limit = definition.match(/set statement_timeout to '(\d+)s'/);
  assert.ok(limit, "RED phx_customer_directory must keep its own statement_timeout");
  const budget = loader.match(/const DIRECTORY_REQUEST_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(budget, "RED the directory read must name its own client budget");
  assert.ok(
    Number(budget[1].replace(/_/g, "")) > Number(limit[1]) * 1000,
    "RED the directory's client budget must outlast the function's statement_timeout, or the page gives up on a read the database is still answering",
  );
  assert.ok(
    /const supabase = getSupabaseAdmin\(\{ requestTimeoutMs: DIRECTORY_REQUEST_TIMEOUT_MS \}\);\s*const \{ data, error \} = await supabase\.rpc\("phx_customer_directory_json"/.test(loader),
    "RED phx_customer_directory_json must be called through the client carrying that budget, not the default 15s one",
  );
}

export function runCustomerDirectoryRollupTests() {
  const definition = lastDirectoryDefinition();
  const loader = stripComments(read("../src/lib/sales/customer-directory.ts"));
  assertDirectoryCanAnswerInTime(definition, loader);

  // Break tests: each undoes one half of the fix, and its own assertion must fire.
  const broke = (nextDefinition: string, nextLoader: string, expect: RegExp) => {
    assert.throws(() => assertDirectoryCanAnswerInTime(nextDefinition, nextLoader), expect);
  };
  broke(definition.replace(" set enable_nestloop to 'off'", ""), loader, /keep enable_nestloop off/);
  broke(definition.replace("<> all (array(", "<> all (("), loader, /through array\( … \)/);
  broke(definition, loader.replace("= 50_000;", "= 15_000;"), /must outlast/);
  broke(definition, loader.replace("getSupabaseAdmin({ requestTimeoutMs: DIRECTORY_REQUEST_TIMEOUT_MS })", "getSupabaseAdmin()"), /not the default 15s one/);

  const migration = read("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260621260000_customer_directory_rollup.sql");
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
