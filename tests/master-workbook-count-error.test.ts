import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { selectAll } from "../src/lib/sales/master-workbook.ts";

// The Master Workbook turned a failed row-count query into "this table has no rows", so one
// transient error emptied a whole sheet and the download still answered HTTP 200 — an empty
// workbook nobody could tell from an empty table. The validated-batch read ignored its error the
// same way, which emptied every import-row sheet. Source of Sales fix backlog, re-measured
// 2026-09-18, #110.

type Result = { data?: unknown[]; count?: number | null; error: { message: string } | null };

function mockSupabase(head: Result) {
  return {
    from(_table: string) {
      let isHead = false;
      const builder = {
        select(_cols: string, opts?: { head?: boolean }) { isHead = Boolean(opts?.head); return builder; },
        in() { return builder; },
        order() { return builder; },
        range() { return builder; },
        then(resolve: (v: Result) => void) {
          resolve(isHead ? head : { data: [{ alias: "A" }], error: null });
        },
      };
      return builder;
    },
  } as never;
}

export async function runMasterWorkbookCountErrorTests() {
  // 1. A failed count fails the export — it never reads as an empty table.
  await assert.rejects(
    selectAll(mockSupabase({ count: null, error: { message: "statement timeout" } }), "t", "alias", "alias"),
    (error: { message?: string }) => error.message === "statement timeout",
    "a failed row count read as zero rows, emptying the sheet behind an HTTP 200",
  );
  await assert.rejects(
    selectAll(mockSupabase({ count: null, error: { message: "boom" } }), "t", "alias", "alias", {
      column: "batch_id",
      values: ["b1"],
    }),
    (error: { message?: string }) => error.message === "boom",
    "the batched path swallows a failed count",
  );

  // 2. A genuinely empty table is still an empty sheet, and a real count still reads its rows.
  assert.deepEqual(await selectAll(mockSupabase({ count: 0, error: null }), "t", "alias", "alias"), []);
  assert.deepEqual(await selectAll(mockSupabase({ count: 1, error: null }), "t", "alias", "alias"), [{ alias: "A" }]);

  // 3. The validated-batch read checks its error before the import rows are scoped by it.
  const source = readFileSync("src/lib/sales/master-workbook.ts", "utf8");
  assert.match(source, /const \{ data: batchIdData, error: batchIdError \} = await supabase/);
  assert.match(source, /if \(batchIdError\) throw batchIdError;/, "a failed batch-id read empties every import-row sheet");
  assert.doesNotMatch(source, /if \(head\.error\) return \[\]/, "the count error is tolerated again");
}
