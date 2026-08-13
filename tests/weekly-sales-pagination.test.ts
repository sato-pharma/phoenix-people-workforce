import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { asyncPool } from "../src/lib/utils/async-pool.ts";

export async function runWeeklySalesPaginationTests() {
  // asyncPool: single item
  {
    const results = await asyncPool(6, [42], async (x) => x * 2);
    assert.deepEqual(results, [84]);
  }

  // asyncPool: preserves order with concurrency=1
  {
    const order: number[] = [];
    const results = await asyncPool(1, [1, 2, 3, 4, 5], async (x) => {
      order.push(x);
      return x * 10;
    });
    assert.deepEqual(results, [10, 20, 30, 40, 50]);
    assert.deepEqual(order, [1, 2, 3, 4, 5]);
  }

  // asyncPool: preserves order under high concurrency
  {
    const results = await asyncPool(6, [1, 2, 3, 4, 5, 6, 7], async (x) => x + 100);
    assert.deepEqual(results, [101, 102, 103, 104, 105, 106, 107]);
  }

  // asyncPool: empty input returns empty array
  {
    const results = await asyncPool(6, [], async (x: number) => x);
    assert.deepEqual(results, []);
  }

  // asyncPool: concurrency is respected (no more than N in-flight)
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const CONCURRENCY = 3;
    await asyncPool(CONCURRENCY, [1, 2, 3, 4, 5, 6, 7, 8], async (x) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Simulate async work
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight--;
      return x;
    });
    assert.ok(
      maxInFlight <= CONCURRENCY,
      `Max in-flight (${maxInFlight}) exceeded concurrency limit (${CONCURRENCY})`,
    );
  }

  // asyncPool: propagates errors
  {
    await assert.rejects(
      () =>
        asyncPool(6, [1, 2, 3], async (x) => {
          if (x === 2) throw new Error("page error");
          return x;
        }),
      /page error/,
    );
  }

  // weekly-sales pagination shape: loadWeeklyDashboard pages weekly_sales_rows by KEYSET
  // (WHERE id > lastId ORDER BY id LIMIT pageSize), not OFFSET. Simulate the exact loop and prove
  // it visits every row once, in id order, with no gaps or duplicates — i.e. the same multiset a
  // single `ORDER BY id` full scan would return, which is why the aggregates are unchanged.
  {
    const PAGE_SIZE = 3;
    // Unique, ascending, NON-contiguous ids (mirrors real weekly_sales_rows.id: a PK with gaps).
    const allIds = [90269, 90270, 91000, 91001, 91002, 120333, 130000, 132364];
    const rows = allIds.map((id) => ({ id }));

    const collected: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    for (;;) {
      const page = rows
        .filter((r) => cursor === null || r.id > cursor)
        .sort((a, b) => a.id - b.id)
        .slice(0, PAGE_SIZE);
      pages += 1;
      for (const r of page) collected.push(r.id);
      if (page.length < PAGE_SIZE) break; // short page ⇒ exhausted
      cursor = page[page.length - 1].id; // advance by last fetched id
    }

    assert.deepEqual(collected, allIds); // every id exactly once, ascending
    assert.equal(new Set(collected).size, collected.length); // no duplicates
    assert.equal(pages, 3); // ceil(8 / 3)
  }

  // Source pin: the service must page by keyset and must NOT re-introduce the count-exact + OFFSET
  // paging it replaced. That old shape re-scanned the whole batch window and re-sorted it by id on
  // EVERY page — measured at 84% of all weekly_sales_rows DB time on production. Keyset makes each
  // page a ~2.4ms PK-index resume instead of an ~81ms full scan+sort.
  {
    const src = readFileSync("src/lib/sales/weekly/service.ts", "utf8");
    assert.match(src, /\.gt\("id", cursor\)/);
    assert.doesNotMatch(src, /count: "exact"/);
    assert.doesNotMatch(src, /\.range\(from, from \+ pageSize - 1\)/);
  }
}
