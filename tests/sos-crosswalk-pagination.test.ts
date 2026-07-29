import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard for the paging bug that lost 1,262 of 49,713 customer→brick mappings in the June 2026
// import (2.5%), leaving 15,443 units of real sales unmapped.
//
// `selectAllActive` paged with `.range(from, from + 999)` and NO `.order()`. Postgres gives no
// stable row order without ORDER BY, so consecutive pages returned some rows twice and skipped
// others — arbitrarily, differently on every run. The missing mappings were scattered evenly across
// the id range (median id 408k vs 412k for the survivors), every one of them active with a valid
// brick. It read as "these customers were never mapped", which is why it went unnoticed.
//
// OFFSET paging is unsafe here even once ordered: the import WRITES to source_of_sales_customer_map
// while this reads it, and any insert below the cursor shifts later rows across a page boundary. So
// the fix is keyset — order by the bigint PK and seek past the last id read.
//
// This is a source-shape test on purpose. The failure only reproduces against a >1000-row table
// under a live PostgREST, which no unit test can stand up; what CAN be pinned is that the two
// paginators never regress to unordered offset paging.
export function runSosCrosswalkPaginationTests() {
  const crosswalks = readFileSync("src/lib/sales/normalizer/crosswalks.ts", "utf8");
  const list = readFileSync("src/lib/sales/master-data/list.ts", "utf8");

  const body = (src: string, fn: string) => {
    const start = src.indexOf(`export async function ${fn}`) >= 0
      ? src.indexOf(`export async function ${fn}`)
      : src.indexOf(`async function ${fn}`);
    assert.ok(start >= 0, `${fn} must still exist`);
    const rest = src.slice(start);
    const end = rest.indexOf("\n}\n");
    return rest.slice(0, end > 0 ? end : rest.length);
  };

  // ── selectAllActive: keyset, never offset ─────────────────────────────────
  const active = body(crosswalks, "selectAllActive");
  assert.ok(
    /\.order\("id",\s*\{\s*ascending:\s*true\s*\}\)/.test(active),
    "selectAllActive must order by id — unordered paging silently drops rows",
  );
  assert.ok(
    /\.gt\("id",\s*cursor\)/.test(active),
    "selectAllActive must seek past the last id (keyset), not offset",
  );
  assert.ok(
    !/\.range\(/.test(active),
    "selectAllActive must not use .range() — offset paging breaks when the import writes while reading",
  );
  assert.ok(
    /page\.length === 0/.test(active) && /Number\.isFinite\(last\)/.test(active),
    "selectAllActive must terminate on an empty page and on an unusable cursor",
  );

  // ── selectAllRows: ordering is mandatory ──────────────────────────────────
  const rows = body(list, "selectAllRows");
  assert.ok(
    /orderColumn:\s*string[,)]/.test(rows),
    "selectAllRows must REQUIRE orderColumn — it was optional and a caller omitted it",
  );
  assert.ok(
    !/orderColumn\?:/.test(rows),
    "selectAllRows must not make orderColumn optional again",
  );
  assert.ok(
    /\.order\(orderColumn,\s*\{\s*ascending:\s*true\s*\}\)/.test(rows),
    "selectAllRows must always apply the ORDER BY, not apply it conditionally",
  );
  assert.ok(
    !/if\s*\(orderColumn\)/.test(rows),
    "the ORDER BY must be unconditional",
  );

  // ── No caller may reintroduce an unordered read ───────────────────────────
  const importService = readFileSync("src/lib/sales/master-data/import-service.ts", "utf8");
  const bareCalls = [...importService.matchAll(/selectAllRows\(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((args) => !args.includes(","));
  assert.deepEqual(
    bareCalls, [],
    `every selectAllRows call must pass an order column; found bare call(s): ${bareCalls.join(" | ")}`,
  );

  console.log("sos crosswalk pagination tests passed");
}
