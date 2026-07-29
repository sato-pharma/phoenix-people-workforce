import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Guard for the table that has now lost rows to unordered offset pagination more than once.
// `source_of_sales_customer_map` lost 1,262 / 49,713 mappings to `.range()` with no `.order()`
// (#1446), and three more of its readers (customer-suggest, customer-map's existing-key scan, and
// brick-centroids' GPS join) were paging the same unsafe way. Postgres returns NO stable row order
// without ORDER BY, so consecutive `.range()` pages silently overlap and skip rows — differently on
// every run.
//
// This scans the source tree and fails if ANY read of the table pages with `.range()` without a
// stable `.order()` earlier in the same query chain. New code cannot reintroduce the class of bug
// on this table without tripping the test. (Keyset helpers that call `.from(table)` with a variable
// — e.g. crosswalks.ts's `selectAllActive` — are already safe and are not matched by the literal.)
const TABLE = "source_of_sales_customer_map";
const FROM = `.from("${TABLE}")`;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectSourceFiles(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

export function runSosCustomerMapKeysetTests() {
  const root = join(process.cwd(), "src");
  const offenders: string[] = [];

  for (const file of collectSourceFiles(root)) {
    const text = readFileSync(file, "utf8");
    let idx = text.indexOf(FROM);
    while (idx !== -1) {
      // A query chain is short; only look forward from this `.from(...)`.
      const window = text.slice(idx, idx + 1200);
      const rangeAt = window.indexOf(".range(");
      if (rangeAt !== -1) {
        const chainBeforeRange = window.slice(0, rangeAt);
        const isReadThatPages = chainBeforeRange.includes(".select(");
        // The `.range(` must belong to THIS `.from(...)` — no other `.from(` in between.
        const rangeBelongsElsewhere = chainBeforeRange.indexOf(".from(", 1) !== -1;
        if (isReadThatPages && !rangeBelongsElsewhere && !chainBeforeRange.includes(".order(")) {
          const lineNo = text.slice(0, idx).split("\n").length;
          offenders.push(`${file}:${lineNo}`);
        }
      }
      idx = text.indexOf(FROM, idx + FROM.length);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Unordered .range() read(s) of ${TABLE} — add .order("id", { ascending: true }) before .range() (see #1446):\n  ${offenders.join("\n  ")}`,
  );
  console.log(`sos ${TABLE} keyset guard passed (no unordered .range() reads)`);
}
