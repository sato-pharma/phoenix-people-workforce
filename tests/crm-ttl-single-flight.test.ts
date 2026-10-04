import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { memoInFlight, type SingleFlightEntry } from "../src/lib/crm/ttl-single-flight.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * CRM Master — the whole-mirror memos are single-flight (PERF-019).
 *
 * The double-visit triples and the vacation periods are each a multi-page scan of the whole CRM
 * mirror, memoised for 60 s. The memo stored the VALUE once it resolved, so until the first scan
 * finished every concurrent caller started its own — the load the memo exists to prevent.
 * `memoInFlight` stores the PROMISE. Every rule below runs on an injected clock, so nothing here
 * depends on real time.
 */

const ROOT = new URL("../", import.meta.url);
const TTL = 60_000;

/** A compute whose settlement the test controls, counting how often it was started. */
function controllable<T>() {
  let starts = 0;
  const pending: Array<{ resolve: (value: T) => void; reject: (error: unknown) => void }> = [];
  const compute = () => {
    starts += 1;
    return new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return {
    compute,
    starts: () => starts,
    resolveNext: (value: T) => pending.shift()!.resolve(value),
    rejectNext: (error: unknown) => pending.shift()!.reject(error),
  };
}

export async function runCrmTtlSingleFlightTests(): Promise<void> {
  // ── 1. Two concurrent callers compute ONCE and share the value ───────────────────────────────
  {
    let clock = 1_000;
    const now = () => clock;
    const cache = new Map<string, SingleFlightEntry<string>>();
    const work = controllable<string>();

    const first = memoInFlight(cache, "k", TTL, 20, work.compute, now);
    const second = memoInFlight(cache, "k", TTL, 20, work.compute, now);
    assert.equal(work.starts(), 1, "🔴 a second caller arriving while the scan runs must share it, not start its own");
    assert.equal(first, second, "both callers hold the very same in-flight promise");
    assert.equal(cache.get("k")?.at, null, "an entry in flight carries no completion time yet");

    clock = 5_000;
    work.resolveNext("triples");
    assert.deepEqual(await Promise.all([first, second]), ["triples", "triples"], "both callers receive the one computed value");
    assert.equal(cache.get("k")?.at, 5_000, "the TTL clock starts at COMPLETION, as the value memo measured it");
  }

  // ── 2. A rejection reaches every sharer, is never cached, and the next call recomputes ───────
  {
    const clock = 1_000;
    const cache = new Map<string, SingleFlightEntry<string>>();
    const work = controllable<string>();

    const first = memoInFlight(cache, "k", TTL, 20, work.compute, () => clock);
    const second = memoInFlight(cache, "k", TTL, 20, work.compute, () => clock);
    const failure = new Error("scan failed");
    work.rejectNext(failure);
    await assert.rejects(first, (error) => error === failure, "the first caller sees the scan's own rejection");
    await assert.rejects(second, (error) => error === failure, "the sharing caller sees the same rejection");
    assert.equal(cache.has("k"), false, "🔴 a failed scan must never stay cached — it would serve the failure for the whole TTL");

    const third = memoInFlight(cache, "k", TTL, 20, work.compute, () => clock);
    assert.equal(work.starts(), 2, "the call after a failure computes afresh");
    work.resolveNext("recovered");
    assert.equal(await third, "recovered", "and its value is served");

    // A compute that throws synchronously takes the same not-cached path.
    const thrown = new Error("thrown synchronously");
    await assert.rejects(
      memoInFlight(cache, "sync", TTL, 20, () => {
        throw thrown;
      }, () => clock),
      (error) => error === thrown,
      "a compute that throws synchronously rejects rather than throwing through the memo",
    );
    assert.equal(cache.has("sync"), false, "and is not cached either");
  }

  // ── 3. A stale rejection never evicts the NEWER entry that replaced it ───────────────────────
  {
    let clock = 0;
    const cache = new Map<string, SingleFlightEntry<string>>();
    const slow = controllable<string>();
    const old = memoInFlight(cache, "k", TTL, 20, slow.compute, () => clock);
    // The map is cleared (as the size bound does) and a newer computation takes the key.
    cache.clear();
    const fresh = controllable<string>();
    const newer = memoInFlight(cache, "k", TTL, 20, fresh.compute, () => clock);
    slow.rejectNext(new Error("old scan failed late"));
    await assert.rejects(old, /old scan failed late/, "the old caller still sees its own failure");
    assert.equal(cache.get("k")?.promise, newer, "🔴 a late rejection deletes its entry only if it is still the same entry");
    clock = 10;
    fresh.resolveNext("new");
    assert.equal(await newer, "new", "the newer computation completes untouched");
  }

  // ── 4. Served at TTL-1 after completion, recomputed at TTL ───────────────────────────────────
  {
    let clock = 0;
    const cache = new Map<string, SingleFlightEntry<number>>();
    let computed = 0;
    const compute = async () => {
      computed += 1;
      return computed;
    };
    const first = await memoInFlight(cache, "k", TTL, 20, compute, () => clock);
    assert.equal(first, 1, "the first call computes");
    const completedAt = cache.get("k")?.at ?? Number.NaN;
    assert.equal(completedAt, 0, "completion was stamped on the injected clock");

    clock = completedAt + TTL - 1;
    assert.equal(await memoInFlight(cache, "k", TTL, 20, compute, () => clock), 1, "🔴 at TTL-1 after completion the cached value is served");
    assert.equal(computed, 1, "nothing was recomputed inside the TTL");

    clock = completedAt + TTL;
    assert.equal(await memoInFlight(cache, "k", TTL, 20, compute, () => clock), 2, "🔴 at exactly TTL after completion the value is recomputed");
    assert.equal(computed, 2, "one recomputation at the TTL boundary");
  }

  // ── 5. The size bound clears the map before a new key goes in ────────────────────────────────
  {
    const clock = 0;
    const cache = new Map<string, SingleFlightEntry<string>>();
    for (const key of ["a", "b", "c"]) await memoInFlight(cache, key, TTL, 3, async () => key, () => clock);
    assert.equal(cache.size, 3, "three keys fill a map bounded at three");
    assert.equal(await memoInFlight(cache, "a", TTL, 3, async () => "recomputed", () => clock), "a", "a live key is still served at the bound");
    assert.equal(cache.size, 3, "serving a cached key does not clear the map");
    await memoInFlight(cache, "d", TTL, 3, async () => "d", () => clock);
    assert.deepEqual([...cache.keys()], ["d"], "🔴 reaching the bound clears the map before the new key goes in, so it never grows without limit");
  }

  // ── 6. CRM Master's two scans go through it, with their TTL and bound unchanged ──────────────
  {
    const master = stripComments(readFileSync(new URL("src/lib/crm/master.ts", ROOT), "utf8"));
    assert.ok(
      /memoInFlight\(triplesCache, key, TRIPLES_CACHE_TTL_MS, TRIPLES_CACHE_MAX, \(\) => computeTriplesUncached\(range\)\)/.test(master),
      "computeTriplesInRange must memoise computeTriplesUncached through memoInFlight",
    );
    assert.ok(
      /memoInFlight\(vacationsCache, key, VACATIONS_CACHE_TTL_MS, VACATIONS_CACHE_MAX, \(\) =>\s*computeVacationPeriodsUncached\(range\),?\s*\)/.test(master),
      "computeVacationPeriods must memoise computeVacationPeriodsUncached through memoInFlight",
    );
    assert.ok(master.includes("const TRIPLES_CACHE_TTL_MS = 60_000;") && master.includes("const TRIPLES_CACHE_MAX = 20;"), "the triples TTL and bound are unchanged");
    assert.ok(master.includes("const VACATIONS_CACHE_TTL_MS = 60_000;") && master.includes("const VACATIONS_CACHE_MAX = 20;"), "the vacations TTL and bound are unchanged");
    assert.doesNotMatch(master, /\.set\(key, \{ at: Date\.now\(\), value \}\)/, "no value-only memo (the non-single-flight shape) is left in CRM Master");
  }

  console.log("crm ttl single-flight: OK");
}
