import assert from "node:assert/strict";

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

  // weekly-sales pagination shape: simulate multi-page count-then-fetch pattern
  {
    const PAGE_SIZE = 3;
    const TOTAL = 8; // 3 pages: [0..2], [3..5], [6..7]
    const allItems = Array.from({ length: TOTAL }, (_, i) => i);

    // Page 0 with count
    const firstPageData = allItems.slice(0, PAGE_SIZE);
    const totalCount = TOTAL;

    // Remaining page offsets
    const remainingFroms: number[] = [];
    for (let from = PAGE_SIZE; from < totalCount; from += PAGE_SIZE) remainingFroms.push(from);
    assert.deepEqual(remainingFroms, [3, 6]);

    // Fetch remaining pages concurrently
    const pages = await asyncPool(6, remainingFroms, async (from) => {
      return allItems.slice(from, from + PAGE_SIZE);
    });

    const collected = [...firstPageData, ...pages.flat()];
    assert.deepEqual(collected, allItems);
  }
}
