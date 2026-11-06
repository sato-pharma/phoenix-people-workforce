import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { summarizePreview } from "../src/lib/sales/recognize.ts";
import { parseUnmappedCustomers } from "../src/lib/sales/normalizer/unmapped-customers.ts";
import type { NormalizeResult } from "../src/lib/sales/normalizer/types.ts";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// SoS Magic shows every ignored row and every unmapped customer (owner, 2026-10-10: "show every single thing").
// The Needs mapping tab only counted ignored rows ("237 ignored") and only listed what the one analyzed file did
// not know, so a customer switched off in the database never appeared there.

function theIgnoredCountCarriesItsRowsUncut() {
  const ignoredRows = Array.from({ length: 237 }, (_, i) => ({
    rawProduct: `P-${i}`,
    rawProductName: i % 2 ? "Some product" : "",
    rawRowNumber: i + 2,
    qty: i + 1,
    reason: i % 3 === 0 ? ("bonus" as const) : ("ignore_mapped" as const),
  }));
  const result = {
    coded: [],
    distributorCode: "TEST",
    exceptions: [],
    ignoredRows,
    blankCustomerRows: [],
    customerBrickCorrections: [],
    summary: { brickResolved: 0, blankCustomerSkipped: 0, fullyCoded: 0, ignored: 237, productResolved: 0, totalRows: 237 },
  } as unknown as NormalizeResult;

  const preview = summarizePreview("TEST", "Test distributor", result, []);
  assert.equal(preview.ignoredRows.length, 237, "every ignored row travels with the preview, none cut");
  assert.equal(preview.ignoredRows[0]?.rowNumber, 2, "each row keeps its own number in the sheet");
  assert.equal(preview.ignoredRows[0]?.reason, "bonus", "a free-goods row says so");
  assert.equal(preview.ignoredRows[1]?.reason, "ignore_mapped", "a product mapped to ignore says so");
  assert.equal(preview.ignoredRows[1]?.productName, "Some product", "the sheet's own product name is kept");
  assert.equal(preview.ignoredRows[2]?.productName, "P-2", "a row with no name falls back to the code the sheet wrote");
  assert.equal(preview.ignoredRows[236]?.qty, 237, "the units the sheet carried are kept");
}

function theUnmappedRowsAreReadAsTheDatabaseGivesThem() {
  const parsed = parseUnmappedCustomers([
    {
      distributor_code: "IS",
      customer_code: "123",
      customer_name: "El Nour",
      address: "Sohag",
      why: "switched off",
      last_brick_id: "B1",
      last_area_code: "A1",
      last_source: "owner-ruling",
      switched_off_at: "2026-10-10T00:51:00+03:00",
      sales_rows: "4",
      first_period: "2026-08",
      last_period: "2026-09",
      lines: "CNS, Pedia",
    },
    { distributor_code: "PS", customer_code: "9", why: "something else", sales_rows: null },
  ]);
  assert.equal(parsed.customers.length, 2);
  assert.equal(parsed.customers[0]?.why, "switched off");
  assert.equal(parsed.customers[0]?.salesRows, 4, "a bigint that arrives as text is read as a number");
  assert.equal(parsed.customers[0]?.lastBrickId, "B1", "the brick it held is kept, so it can be put back");
  assert.equal(parsed.customers[1]?.why, "never mapped", "anything that is not switched off reads as never mapped");
  assert.equal(parsed.customers[1]?.salesRows, 0);
  assert.equal(parsed.possiblyTruncated, false);

  const full = parseUnmappedCustomers(Array.from({ length: 1500 }, (_, i) => ({ distributor_code: "IS", customer_code: String(i), why: "never mapped" })));
  assert.equal(full.customers.length, 1500, "a list past 1,000 rows is kept whole, none cut");
  assert.equal(full.possiblyTruncated, false, "the list is read in full, so a long one is never reported as cut");
  const source = read("src/lib/sales/normalizer/unmapped-customers.ts");
  assert.ok(/rpcAll\(\s*getSupabaseAdmin\(\), "sos_unmapped_customers"/.test(source), "the list is read through rpcAll, which pages past a server row ceiling");
  assert.ok(!/\.rpc\("sos_unmapped_customers"/.test(source), "never a bare .rpc(), which stops silently at the ceiling");
  assert.equal(parseUnmappedCustomers(null).customers.length, 0, "a missing answer is an empty list, not a crash");
}

function theDatabaseFunctionAndRouteAreLockedDown() {
  const migration = read("supabase/migrations/20261010040000_sos_unmapped_customers_list.sql");
  assert.match(migration, /create or replace function public\.sos_unmapped_customers\(\)/);
  assert.match(migration, /where a\.active/, "a customer with an ACTIVE row is never listed");
  assert.match(migration, /full join off_rows o/, "switched-off customers with no sales and sold-but-never-mapped ones are both listed");
  assert.match(
    migration,
    /revoke execute on function public\.sos_unmapped_customers\(\) from public, anon, authenticated;/,
    "no browser role can call it",
  );
  assert.match(migration, /grant execute on function public\.sos_unmapped_customers\(\) to service_role;/, "only the server can");
  assert.ok(!/\bvalue\b/.test(migration.replace(/--.*$/gm, "")), "it carries counts only, never money, so no Head Office figure can leak");

  const route = read("app/api/sales/normalizer/unmapped-customers/route.ts");
  assert.ok(route.includes('access.role !== "Super Admin" && access.scope !== "system"'), "Super Admin only, like the rest of the Source Normalizer");
  assert.ok(route.includes('assertPermission(access, "sales", "import")'), "and it needs sales:import");
  assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(route), "read-only");
  assert.ok(read("src/lib/security/access-registry.ts").includes('"/api/sales/normalizer/unmapped-customers"'), "registered, or the access-registry gate fails");
}

function theScreenShowsBothLists() {
  const tabs = read("src/components/sales/normalizer-tabs.tsx");
  assert.ok(tabs.includes("Unmapped customers") && tabs.includes("<NormalizerUnmappedCustomers />"), "the Unmapped customers tab is on the page");

  const workspace = read("src/components/sales/normalizer-workspace.tsx");
  assert.ok(workspace.includes("Ignored rows ("), "the Ignored rows tab sits beside Needs mapping");
  assert.ok(workspace.includes("<NormalizerIgnoredRows"), "and renders the rows");

  const panel = read("src/components/sales/normalizer-unmapped-customers.tsx");
  assert.ok(panel.includes("possiblyTruncated"), "a possibly cut list says so");
  assert.ok(panel.includes('timeZone: "Africa/Cairo"'), "times are Cairo local");
  assert.ok(panel.includes("md:hidden") && panel.includes("table-fixed"), "cards on a phone, a fixed-layout table on a desktop — never a horizontal scroll");
}

export function runNormalizerUnmappedAndIgnoredListsTests() {
  theIgnoredCountCarriesItsRowsUncut();
  theUnmappedRowsAreReadAsTheDatabaseGivesThem();
  theDatabaseFunctionAndRouteAreLockedDown();
  theScreenShowsBothLists();
}
