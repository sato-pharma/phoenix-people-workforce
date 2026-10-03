import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WEEKLY_ROW_CACHE_MAX_ENTRIES,
  WEEKLY_ROW_CACHE_MAX_ROWS_TOTAL,
  WEEKLY_ROW_CACHE_TTL_MS,
  _resetWeeklyRowCache,
  bumpWeeklyRowsGeneration,
  getOrLoadWeeklyRows,
  weeklyRowCacheKey,
} from "../src/lib/sales/weekly/row-cache.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-002 (2026-10-04): weekly dashboards re-paged every weekly row on every view. The rows are now
 * kept in memory for 60 s per exact read, and every weekly write drops them. These pin the four ways
 * that cache could serve a WRONG number: kept past its lifetime, kept past a write, shared across two
 * different reads, or handed out as the same objects the next caller then re-prices in place.
 */
export async function runWeeklyRowCacheTests() {
  type Row = { id: number; salesValue: number };
  let clock = 1_000_000;
  const now = () => clock;
  const loader = (rows: Row[]) => {
    const calls = { count: 0 };
    const load = async () => {
      calls.count += 1;
      return { rows: rows.map((row) => ({ ...row })), pages: 3 };
    };
    return { calls, load };
  };

  // A second identical read inside the lifetime is served from memory.
  {
    _resetWeeklyRowCache();
    const { calls, load } = loader([{ id: 1, salesValue: 10 }]);
    const first = await getOrLoadWeeklyRows("k", load, now);
    const second = await getOrLoadWeeklyRows("k", load, now);
    assert.equal(first.cache, "miss");
    assert.equal(second.cache, "hit", "an identical read inside 60 s must not page the table again");
    assert.equal(calls.count, 1);
    assert.deepEqual(second.rows, [{ id: 1, salesValue: 10 }]);
  }

  // Past the lifetime it reads again.
  {
    _resetWeeklyRowCache();
    const { calls, load } = loader([{ id: 1, salesValue: 10 }]);
    await getOrLoadWeeklyRows("k", load, now);
    clock += WEEKLY_ROW_CACHE_TTL_MS;
    const later = await getOrLoadWeeklyRows("k", load, now);
    assert.equal(later.cache, "miss", "a cached read must expire after 60 s — the backstop for writes the app never sees");
    assert.equal(calls.count, 2);
  }

  // Any weekly write drops what was cached.
  {
    _resetWeeklyRowCache();
    const { calls, load } = loader([{ id: 1, salesValue: 10 }]);
    await getOrLoadWeeklyRows("k", load, now);
    bumpWeeklyRowsGeneration("test");
    const after = await getOrLoadWeeklyRows("k", load, now);
    assert.equal(after.cache, "miss", "a weekly write must drop every cached read");
    assert.equal(calls.count, 2);
  }

  // A load that was running when a write landed is served but never kept.
  {
    _resetWeeklyRowCache();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const slow = async () => {
      calls += 1;
      await gate;
      return { rows: [{ id: 1, salesValue: 10 }], pages: 1 };
    };
    const pending = getOrLoadWeeklyRows("k", slow, now);
    bumpWeeklyRowsGeneration("write during the read");
    release();
    await pending;
    const next = await getOrLoadWeeklyRows("k", slow, now);
    assert.equal(next.cache, "miss", "rows read across a write may predate it and must not be kept");
    assert.equal(calls, 2);
  }

  // Concurrent identical reads share one load.
  {
    _resetWeeklyRowCache();
    const { calls, load } = loader([{ id: 1, salesValue: 10 }]);
    const [a, b] = await Promise.all([getOrLoadWeeklyRows("k", load, now), getOrLoadWeeklyRows("k", load, now)]);
    assert.equal(calls.count, 1, "two concurrent identical reads must share one fetch");
    assert.deepEqual(a.rows, b.rows);
    assert.notEqual(a.rows[0], b.rows[0], "each caller gets its own copies");
  }

  // Copies on every read: re-pricing one caller's rows must not touch the next caller's.
  {
    _resetWeeklyRowCache();
    const { load } = loader([{ id: 1, salesValue: 10 }]);
    const first = await getOrLoadWeeklyRows("k", load, now);
    first.rows[0].salesValue = 999;
    const second = await getOrLoadWeeklyRows("k", load, now);
    assert.equal(second.rows[0].salesValue, 10, "a caller mutating its rows must never change the cached rows");
    second.rows[0].salesValue = 777;
    const third = await getOrLoadWeeklyRows("k", load, now);
    assert.equal(third.rows[0].salesValue, 10, "a cache HIT must hand out copies too");
  }

  // Bounded: least-recently-used entries go first, and an oversize read is never kept.
  {
    _resetWeeklyRowCache();
    const { calls, load } = loader([{ id: 1, salesValue: 10 }]);
    for (let i = 0; i <= WEEKLY_ROW_CACHE_MAX_ENTRIES; i += 1) await getOrLoadWeeklyRows(`k${i}`, load, now);
    assert.equal(calls.count, WEEKLY_ROW_CACHE_MAX_ENTRIES + 1);
    assert.equal((await getOrLoadWeeklyRows("k0", load, now)).cache, "miss", "the oldest entry must be evicted past the cap");
    assert.equal((await getOrLoadWeeklyRows(`k${WEEKLY_ROW_CACHE_MAX_ENTRIES}`, load, now)).cache, "hit");

    _resetWeeklyRowCache();
    const huge = Array.from({ length: WEEKLY_ROW_CACHE_MAX_ROWS_TOTAL + 1 }, (_, id) => ({ id, salesValue: 1 }));
    const big = loader(huge);
    await getOrLoadWeeklyRows("big", big.load, now);
    assert.equal((await getOrLoadWeeklyRows("big", big.load, now)).cache, "miss", "an oversize read is served but not stored");

    // The row budget holds across entries: two reads that together pass it keep only the newer one.
    _resetWeeklyRowCache();
    const half = Array.from({ length: Math.floor(WEEKLY_ROW_CACHE_MAX_ROWS_TOTAL / 2) + 1 }, (_, id) => ({ id, salesValue: 1 }));
    const first = loader(half);
    const second = loader(half);
    await getOrLoadWeeklyRows("half-a", first.load, now);
    await getOrLoadWeeklyRows("half-b", second.load, now);
    assert.equal((await getOrLoadWeeklyRows("half-b", second.load, now)).cache, "hit");
    assert.equal(
      (await getOrLoadWeeklyRows("half-a", first.load, now)).cache,
      "miss",
      "the cache must evict its oldest entry once the rows it holds pass the total budget",
    );
  }

  // The key separates different reads: other batches, another distributor narrowing, a retagged batch.
  {
    const batches = [
      { id: "a", week_start: "2026-09-07", cycle_month: "2026-09-01", distributor_code: "PS" },
      { id: "b", week_start: "2026-09-14", cycle_month: "2026-09-01", distributor_code: "RM" },
    ];
    const base = weeklyRowCacheKey({ batches, batchIds: ["a", "b"], distributorCodes: null });
    assert.equal(base, weeklyRowCacheKey({ batches, batchIds: ["b", "a"], distributorCodes: null }), "order of ids is not a different read");
    assert.notEqual(base, weeklyRowCacheKey({ batches, batchIds: ["a"], distributorCodes: null }));
    assert.notEqual(base, weeklyRowCacheKey({ batches, batchIds: ["a", "b"], distributorCodes: ["PS"] }));
    const retagged = [{ ...batches[0], cycle_month: "2026-08-01" }, batches[1]];
    assert.notEqual(base, weeklyRowCacheKey({ batches: retagged, batchIds: ["a", "b"], distributorCodes: null }), "a retagged batch is a new read");
  }

  // Every app path that writes weekly rows or batches drops the cache.
  {
    const service = stripComments(readFileSync(new URL("../src/lib/sales/weekly/service.ts", import.meta.url), "utf8"));
    const bodyOf = (name: string) => {
      const start = service.indexOf(`export async function ${name}(`);
      assert.ok(start >= 0, `${name} not found`);
      const end = service.indexOf("\nexport ", start + 10);
      return service.slice(start, end < 0 ? undefined : end);
    };
    for (const [fn, reason] of [
      ["importWeeklySalesFile", '"upload"'],
      ["deleteWeeklyBatch", '"delete"'],
      ["retagWeeklyBatch", '"retag"'],
    ] as const) {
      assert.ok(bodyOf(fn).includes(`bumpWeeklyRowsGeneration(${reason})`), `${fn} must drop the weekly row cache after it writes`);
    }
    const aliases = stripComments(readFileSync(new URL("../src/lib/sales/weekly/product-aliases.ts", import.meta.url), "utf8"));
    assert.match(
      aliases,
      /bumpWeeklyRowsGeneration\("alias_heal"\)/,
      "healing rewrites rows inside the same batches — the key cannot see it, so the heal must drop the cache",
    );
    assert.match(
      service,
      /getOrLoadWeeklyRows\(\s*weeklyRowCacheKey\(\{ batches, batchIds: batchIdsForRows, distributorCodes: distributorCodesForQuery \}\)/,
      "the dashboard's row read must go through the cache with the exact batches and distributor narrowing as its key",
    );
  }

  _resetWeeklyRowCache();
}
