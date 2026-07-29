import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression for audit finding M18: listMasterRows (src/lib/sales/master-data/list.ts) and
// preloadKeyed (src/lib/sales/master-data/import-service.ts) both did a bare .select("*") with no
// .range()/.limit() against master/reference tables (regions, areas, blocks, bricks, products,
// distributors). PostgREST caps an unpaginated select at ~1000 rows with no error — a table that
// grew past that would be silently truncated, with no indication to the caller. Both functions are
// DB-backed and not directly unit-testable without a live/mocked Supabase client, so this is a
// source-text regression test, matching the convention used elsewhere in this suite for DB-backed
// functions (e.g. tests/sales-restricted-products.test.ts).
export function runSalesMasterDataPaginationTests() {
  const listSource = readFileSync("src/lib/sales/master-data/list.ts", "utf8");
  // orderColumn was OPTIONAL when this test was written, and preloadKeyed omitted it. Paging with
  // .range() over an unordered result silently drops and duplicates rows — that is how the June 2026
  // import lost 1,262 customer→brick mappings. It is now required; see
  // tests/sos-crosswalk-pagination.test.ts.
  assert.match(
    listSource,
    /export async function selectAllRows\(table: string, orderColumn: string\): Promise<Record<string, unknown>\[\]>/,
    "a shared paginated-read helper exists, and ordering is mandatory",
  );
  assert.match(
    listSource,
    /for \(let from = 0; ; from \+= PAGE_SIZE\)/,
    "the helper walks every page instead of reading a single unbounded select",
  );
  assert.match(
    listSource,
    /\.range\(from, from \+ PAGE_SIZE - 1\)/,
    "each page is fetched with an explicit range, never a bare select",
  );
  assert.match(
    listSource,
    /export async function listMasterRows\(master: MasterKey\): Promise<MasterRowRecord\[\]> \{\s*const definition = MASTER_DEFINITIONS\[master\];\s*const rows = await selectAllRows\(definition\.table, definition\.keyColumn\);/,
    "listMasterRows now reads through the paginated helper instead of a bare .select(\"*\")",
  );

  const importServiceSource = readFileSync("src/lib/sales/master-data/import-service.ts", "utf8");
  assert.match(
    importServiceSource,
    /import \{ selectAllRows \} from "\.\/list";/,
    "import-service.ts reuses the shared paginated helper instead of duplicating a second pagination loop",
  );
  assert.match(
    importServiceSource,
    /async function preloadKeyed\(table: string, keyColumn: string\) \{[\s\S]{0,200}?const rows = await selectAllRows\(table, keyColumn\);/,
    "preloadKeyed reads through the paginated helper AND orders by the key it indexes on",
  );
  assert.doesNotMatch(
    importServiceSource,
    /const \{ data, error \} = await supabase\.from\(table\)\.select\("\*"\);/,
    "the unbounded select inside preloadKeyed is gone",
  );
}
