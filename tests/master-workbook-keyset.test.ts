import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  keysetSelectImportRows,
  buildAliasDistributorMapsFromRows,
} from "../src/lib/sales/master-workbook.ts";
import { normalizeAliasKey } from "../src/lib/sales/normalizer/resolvers.ts";

/**
 * The Master Workbook export used to scan the 450MB source_of_sales_import_rows table TWICE — once
 * for the 22 detail columns and again for (distributor_code, raw_row) to infer alias provenance — and
 * both scans used `.range()`/OFFSET pagination, which re-walks every preceding row on each of ~300
 * pages (O(n^2): a prod page at offset 300k took 649ms vs 4ms for the equivalent keyset page).
 *
 * The fix: ONE keyset pass over the integer PK (WHERE id > cursor ORDER BY id LIMIT n) that also
 * carries raw_row, folded into the alias maps in-process. This test pins the two ways that could
 * silently regress and move — or blank — the downloaded workbook:
 *   1. the keyset walk must lose no row and duplicate none, and must preserve the EXACT order the old
 *      pager produced (chunks of 100 batch ids, each ascending by id, concatenated in chunk order) —
 *      Raw_Sales / Normalized_Sales / Exceptions render rows in that order, so a change is visible;
 *   2. the alias→distributor fold must still read raw_row (its column must ride the single detail
 *      read) and attribute each alias to every distributor whose profile columns carry it.
 */

type Row = Record<string, unknown>;

// A mock PostgREST builder that honours exactly the operators keysetSelectImportRows uses:
// .select().in("batch_id", ids).gt("id", cursor).order("id",{ascending:true}).limit(n), awaited.
function mockSupabase(dataset: Row[]) {
  return {
    from(_table: string) {
      const s = { inVals: [] as string[], gtVal: 0, lim: Number.POSITIVE_INFINITY };
      const builder = {
        select(_cols: string) { return builder; },
        in(_col: string, vals: string[]) { s.inVals = vals; return builder; },
        gt(_col: string, val: number) { s.gtVal = val; return builder; },
        order(_col: string, _opts: { ascending: boolean }) { return builder; },
        limit(n: number) { s.lim = n; return builder; },
        then(resolve: (v: { data: Row[]; error: null }) => void) {
          const rows = dataset
            .filter((r) => s.inVals.includes(String(r.batch_id)) && Number(r.id) > s.gtVal)
            .sort((a, b) => Number(a.id) - Number(b.id))
            .slice(0, s.lim);
          resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };
}

const asAdmin = (m: ReturnType<typeof mockSupabase>) =>
  m as unknown as Parameters<typeof keysetSelectImportRows>[0];

export async function runMasterWorkbookKeysetTests() {
  // ── 1. keyset walk within one chunk: lossless, unique, ascending, multi-page ──────────────────
  // ids inserted out of order; pageSize 3 forces 4 pages (10 rows) so the cursor advance and the
  // partial-last-page terminator are both exercised.
  const single: Row[] = [70, 7, 35, 14, 63, 28, 56, 21, 49, 42].map((id) => ({
    id, batch_id: "b1", distributor_code: "PS", raw_row: {},
  }));
  const gotSingle = await keysetSelectImportRows(asAdmin(mockSupabase(single)), "id,batch_id", ["b1"], 3);
  assert.deepEqual(
    gotSingle.map((r) => Number(r.id)),
    [7, 14, 21, 28, 35, 42, 49, 56, 63, 70],
    "keyset walk must return every row exactly once, in ascending id order — no dup, no drop across pages",
  );

  // exact-multiple case: 6 rows / pageSize 3 -> [3][3][0]; the empty terminator must not add or lose rows.
  const exact: Row[] = [1, 2, 3, 4, 5, 6].map((id) => ({ id, batch_id: "b1", raw_row: {} }));
  const gotExact = await keysetSelectImportRows(asAdmin(mockSupabase(exact)), "id,batch_id", ["b1"], 3);
  assert.deepEqual(gotExact.map((r) => Number(r.id)), [1, 2, 3, 4, 5, 6], "exact-multiple walk must terminate cleanly at 6 rows");

  // ── 2. multi-chunk order is chunk-then-id, NOT a global id sort (byte-identity of detail sheets) ─
  // 120 batch ids -> two chunks (b000..b099, b100..b119). A HIGH-id row in chunk 1 must precede a
  // LOW-id row in chunk 2 — proving the fold reproduces the old grouped order, not a global sort.
  const batchIds = Array.from({ length: 120 }, (_, i) => `b${String(i).padStart(3, "0")}`);
  const multi: Row[] = [
    { id: 999_999, batch_id: "b000", raw_row: {} }, // chunk 1, highest id
    { id: 1, batch_id: "b100", raw_row: {} },        // chunk 2, lowest id
    { id: 5, batch_id: "b101", raw_row: {} },        // chunk 2
  ];
  const gotMulti = await keysetSelectImportRows(asAdmin(mockSupabase(multi)), "id,batch_id", batchIds, 1000);
  assert.deepEqual(
    gotMulti.map((r) => Number(r.id)),
    [999_999, 1, 5],
    "chunk 1 rows (any id) must come before chunk 2 rows — a global id sort would wrongly give [1,5,999999]",
  );

  // ── 3. alias -> distributor fold reads raw_row and attributes to every carrier ────────────────
  const rows: Row[] = [
    { distributor_code: "PS", raw_row: { "Mat. Code": "ABC123", "Sal. Dist. Desc.": "Cairo District" } },
    { distributor_code: "IS", raw_row: { "Item Code": "ABC123", "Brick Name": "Maadi" } }, // shares the product alias
    { distributor_code: "ZZ", raw_row: { "Mat. Code": "IGNORED" } },                        // unknown distributor
    { distributor_code: "PS", raw_row: null },                                              // null raw_row skipped
  ];
  const { product, territory } = buildAliasDistributorMapsFromRows(rows);

  assert.deepEqual(
    [...(product.get(normalizeAliasKey("ABC123")) ?? [])].sort(),
    ["Ibn sina", "overseas"],
    "a product alias carried by two distributors must be attributed to BOTH",
  );
  assert.deepEqual([...(territory.get(normalizeAliasKey("Cairo District")) ?? [])], ["overseas"]);
  assert.deepEqual([...(territory.get(normalizeAliasKey("Maadi")) ?? [])], ["Ibn sina"]);
  assert.ok(!product.has(normalizeAliasKey("IGNORED")), "an unknown distributor_code contributes no alias provenance");

  // ── 4. source guards: the fix must not silently revert to two scans / drop raw_row / restore cache ─
  const src = readFileSync(new URL("../src/lib/sales/master-workbook.ts", import.meta.url), "utf8");
  assert.ok(src.includes("keysetSelectImportRows"), "the import_rows read must go through the keyset pager");
  assert.ok(
    src.includes("validation_issues,raw_row"),
    "raw_row must ride the single detail read (else the alias columns silently blank)",
  );
  assert.ok(!src.includes("_aliasCache"), "the per-route-segment alias module cache must stay deleted");
  assert.ok(!src.includes("_ALIAS_CACHE_TTL"), "the alias cache TTL must stay deleted");
}
