import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { singleFlight } from "../src/lib/utils/single-flight.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Source of Sales reference reads — the two load fixes of 2026-09-17.
//
// 1. The brick-centroid stampede. `unstable_cache` does not dedupe a miss, and the outstation list
//    resolves one centroid lookup per request row, all at once, on the Super Admin sidebar's
//    30-second badge poll. Each expiry read source_of_sales_bricks once per row — 7,178 reads a day
//    in production, 93% of them in bursts of 61+ inside five seconds. `singleFlight` shares one
//    in-flight lookup between concurrent callers; brick-geo.ts's wiring is pinned in
//    tests/crm-brick-centroids-cache.test.ts. Its behaviour is exercised here for real.
//
// 2. The Master Map change probe. A HEAD `count: "exact"` with no limit makes PostgREST count the
//    whole filtered table twice (the exact count, and the page it would have returned). `.limit(1)`
//    removes the second scan and leaves the exact count — and so the stamp — unchanged; that
//    equality was checked against the staging database before this shipped.
// ─────────────────────────────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

export async function runSosReferenceReadLoadTests() {
  // ── A burst of concurrent callers runs the load ONCE and every caller gets that one value ──
  {
    let loads = 0;
    const gate = deferred<string[]>();
    const shared = singleFlight(() => {
      loads += 1;
      return gate.promise;
    });

    // 61 rows, the smallest burst production recorded, each asking at the same moment.
    const waiters = Array.from({ length: 61 }, () => shared());
    assert.equal(loads, 1, "61 concurrent callers must start exactly one load — one per caller is the stampede this exists to stop");

    const value = ["BRICK-A", "BRICK-B"];
    gate.resolve(value);
    const results = await Promise.all(waiters);
    assert.equal(loads, 1, "no caller may start a second load while the first is still running");
    assert.ok(
      results.every((result) => result === value),
      "every waiter must receive the very value the one load produced — the sharing may never change a result",
    );
  }

  // ── Once settled, the slot is empty: the next call runs a FRESH load (it is not a cache) ────
  {
    let loads = 0;
    const shared = singleFlight(async () => {
      loads += 1;
      return loads;
    });

    assert.equal(await shared(), 1, "the first call runs the load");
    assert.equal(await shared(), 2, "a call after the first has settled must run the load again — holding the value would add a second, untagged cache on top of unstable_cache's 300 s window");
    assert.equal(loads, 2, "two sequential calls are two loads");
  }

  // ── A failure reaches every waiter, is never remembered, and the next call retries ──────────
  {
    let loads = 0;
    const gate = deferred<string>();
    const shared = singleFlight(() => {
      loads += 1;
      return loads === 1 ? gate.promise : Promise.resolve("recovered");
    });

    const first = shared();
    const second = shared();
    const failure = new Error("transient database error");
    gate.reject(failure);

    await assert.rejects(first, (error) => error === failure, "the caller that started the load sees its failure");
    await assert.rejects(second, (error) => error === failure, "a caller that joined the load sees the same failure, so its own catch decides the fallback");
    assert.equal(await shared(), "recovered", "after a failure the slot must be clear — the next call retries instead of receiving the old rejection");
    assert.equal(loads, 2, "the retry is a real second load");
  }

  // ── A synchronous throw in the load becomes a rejection, and still clears the slot ─────────
  {
    let loads = 0;
    const shared = singleFlight<string>(() => {
      loads += 1;
      if (loads === 1) throw new Error("threw before returning a promise");
      return Promise.resolve("second attempt");
    });

    let thrownSynchronously = false;
    let first: Promise<string> | undefined;
    try {
      first = shared();
    } catch {
      thrownSynchronously = true;
    }
    assert.equal(thrownSynchronously, false, "a synchronous throw must not escape to whichever caller arrived first");
    await assert.rejects(first!, /threw before returning a promise/, "it arrives as a rejection of the shared promise instead");
    assert.equal(await shared(), "second attempt", "and the slot is clear for the next call");
  }

  // ── Master Map probe: the exact count is limited to a one-row page ─────────────────────────
  {
    const fingerprint = readFileSync(new URL("../src/lib/sales/master-map/fingerprint.ts", import.meta.url), "utf8");
    assert.match(
      fingerprint,
      /\.select\("\*",\s*\{\s*count:\s*"exact",\s*head:\s*true\s*\}\)\.limit\(1\)/,
      "the Master Map count probe must ask for a one-row page — without it PostgREST counts the whole customer map a second time on every 5-minute poll",
    );
    assert.match(
      fingerprint,
      /count:\s*"exact"/,
      "the count must stay EXACT — an estimated or planned count could move without a real change and repaint the workbook",
    );
    assert.match(
      fingerprint,
      /return `\$\{entry\.key\}:\$\{countResult\.count \?\? 0\}:\$\{newest\}`;/,
      "the stamp must still be built from the exact count and the newest write, so a live sheet sees no change from this fix",
    );
  }
}
