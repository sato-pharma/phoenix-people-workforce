import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RESTRICTED_PRODUCT_CODES } from "../src/lib/sales/access-scope.ts";

const MIGRATIONS_URL = new URL("../supabase/migrations/", import.meta.url);

function readMigration(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, MIGRATIONS_URL)), "utf8");
}

// `p_exclude_codes` used to mean two OPPOSITE things: omitting it HID the confidential products in
// analytics_sos_* but REVEALED them in 17 other RPCs that defaulted to '{}'. Migration
// 20260802022100 makes the fail-closed default universal; 20260802022000 drops 7 dead RPCs that
// carried the fail-open default with no caller at all.
//
// The migration hardcodes the confidential codes in SQL, where TypeScript cannot reach them. This
// pins the two lists together: adding a 4th code to RESTRICTED_PRODUCT_CODES without updating the
// SQL default would silently leave that product revealed to any caller that omits the argument.
export function runSqlExcludeCodesFailClosedTests() {
  const defaultsMigration = readMigration("20260802022100_fail_closed_exclude_codes_defaults.sql");
  const dropMigration = readMigration("20260802022000_drop_dead_sales_intelligence_rpcs.sql");

  // ── The SQL default must list exactly the TypeScript restricted codes ──────────────────────
  // [\s\S] rather than `.` with the /s flag — this repo's tsconfig target predates ES2018 dotAll.
  const declared = defaultsMigration.match(/DEFAULT ARRAY\[([\s\S]+?)\]';/)?.[1];
  assert.ok(declared, "the migration declares a fail-closed DEFAULT ARRAY[...] for the exclusion arg");

  const sqlCodes = [...declared.matchAll(/''([A-Z0-9]+)''::text/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    sqlCodes,
    [...RESTRICTED_PRODUCT_CODES].map((code) => code.toUpperCase()).sort(),
    "the SQL fail-closed default and RESTRICTED_PRODUCT_CODES must list the same confidential codes — "
      + "a code added to one and not the other is revealed to every caller that omits the argument",
  );

  // ── The migration must stay loud, not best-effort ──────────────────────────────────────────
  // A silent no-op here would look identical to success while leaving the defaults fail-open.
  assert.ok(
    /RAISE EXCEPTION/.test(defaultsMigration),
    "the migration raises rather than silently skipping a function it cannot match",
  );
  assert.ok(
    /still carry a fail-open exclusion default/.test(defaultsMigration),
    "a post-condition asserts no targeted function retains the fail-open default",
  );
  assert.ok(
    /has_function_privilege\('service_role'/.test(defaultsMigration),
    "a post-condition asserts service_role kept EXECUTE (CREATE OR REPLACE must not reset the ACL)",
  );

  // ── The drop migration must not touch phx_customer_directory ───────────────────────────────
  // It has no TypeScript caller, so it LOOKS dead — but phx_customer_directory_json (live, via
  // src/lib/sales/customer-directory.ts) calls it from SQL. Dropping it breaks the directory.
  assert.ok(
    !/DROP FUNCTION[^\n]*phx_customer_directory\b/.test(dropMigration),
    "phx_customer_directory must NOT be dropped — phx_customer_directory_json calls it from SQL",
  );
  assert.equal(
    (dropMigration.match(/^DROP FUNCTION/gm) ?? []).length,
    7,
    "the drop migration removes exactly the 7 verified-dead RPCs",
  );

  // ── Both migrations must be registered under the expected timestamped names ────────────────
  const files = readdirSync(fileURLToPath(MIGRATIONS_URL));
  for (const name of [
    "20260802022000_drop_dead_sales_intelligence_rpcs.sql",
    "20260802022100_fail_closed_exclude_codes_defaults.sql",
  ]) {
    assert.ok(files.includes(name), `${name} is present in supabase/migrations`);
  }
}
