import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHARED_READ_TTL_MS,
  _resetSharedReadCache,
  bumpSharedReadGeneration,
  getOrLoadShared,
  sharedReadKey,
} from "../src/lib/cache/shared-read.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A DASHBOARD MAY REUSE A HEAVY READ FOR UP TO A MINUTE — AND NOTHING ELSE MAY (2026-10-16).
//
// The SFE Command Center read the whole company's 30 days of CRM visits and check-ins on every render: a
// probe plus a request per day, about 62 round trips, paid again by every viewer. The owner chose the
// freshness that day — a copy up to one minute old, refreshed at once by a write the app makes.
//
// Pinned here: the cache's own contract (lifetime, shared loads, a write drops it, a load a write
// overtook is never kept, nothing stored is handed out by reference, the bounds), and the two promises
// around it — ONLY a display reader opts in, and the app's own visit write refreshes it.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LIMITS = { maxEntries: 3, maxRowsTotal: 10 };

function code(path: string): string {
  return stripComments(readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n"));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function runSharedReadCacheTests() {
  // ── (1) A copy lives one minute, then the next read goes to the source ────────
  {
    _resetSharedReadCache();
    let clock = 1_000;
    const now = () => clock;
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{ id: loads }];
    };
    const first = await getOrLoadShared("t", "k", load, LIMITS, now);
    assert.equal(first.cache, "miss");
    clock += SHARED_READ_TTL_MS - 1;
    const second = await getOrLoadShared("t", "k", load, LIMITS, now);
    assert.equal(second.cache, "hit", "inside the minute the copy is served");
    assert.equal(loads, 1);
    clock += 1;
    const third = await getOrLoadShared("t", "k", load, LIMITS, now);
    assert.equal(third.cache, "miss", "RED a copy older than the owner's one minute must never be served");
    assert.equal(loads, 2);
    assert.equal(SHARED_READ_TTL_MS, 60_000, "the owner chose up to ONE minute (2026-10-16) — never widen it silently");
  }

  // ── (2) Two viewers missing at once share ONE load ────────────────────────────
  {
    _resetSharedReadCache();
    const gate = deferred<{ id: number }[]>();
    let loads = 0;
    const load = () => {
      loads += 1;
      return gate.promise;
    };
    const a = getOrLoadShared("t", "k", load, LIMITS);
    const b = getOrLoadShared("t", "k", load, LIMITS);
    gate.resolve([{ id: 1 }]);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(loads, 1, "concurrent misses on one key must share a single load");
    assert.deepEqual(ra.rows, [{ id: 1 }]);
    assert.notEqual(ra.rows, rb.rows, "each caller gets its own array");
  }

  // ── (3) A write drops the copy, and a load the write overtook is served but never kept ─
  {
    _resetSharedReadCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{ id: loads }];
    };
    await getOrLoadShared("t", "k", load, LIMITS);
    bumpSharedReadGeneration("t", "test write");
    const afterWrite = await getOrLoadShared("t", "k", load, LIMITS);
    assert.equal(afterWrite.cache, "miss", "RED a write must make the very next read go to the database");
    assert.equal(loads, 2);

    const gate = deferred<{ id: number }[]>();
    bumpSharedReadGeneration("t", "reset");
    const racing = getOrLoadShared("t", "k", () => gate.promise, LIMITS);
    bumpSharedReadGeneration("t", "a write lands while the read is running");
    gate.resolve([{ id: 99 }]);
    assert.deepEqual((await racing).rows, [{ id: 99 }], "the overtaken load is still served to its caller");
    const next = await getOrLoadShared("t", "k", load, LIMITS);
    // Two guards hold this, each enough alone: the generation is part of every key, and a load whose
    // generation moved is not stored. Breaking only one of them leaves the behaviour correct.
    assert.equal(next.cache, "miss", "RED a load that started before a write must never be kept — it may miss the write");

    // Namespaces are independent: a CRM write does not drop another namespace's copy.
    await getOrLoadShared("other", "k", load, LIMITS);
    bumpSharedReadGeneration("t", "write");
    assert.equal((await getOrLoadShared("other", "k", load, LIMITS)).cache, "hit");
  }

  // ── (4) A missing source (null) is passed through and never stored ────────────
  {
    _resetSharedReadCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return null;
    };
    assert.equal((await getOrLoadShared("t", "k", load, LIMITS)).rows, null);
    await getOrLoadShared("t", "k", load, LIMITS);
    assert.equal(loads, 2, "a null answer must not be remembered for a minute");
  }

  // ── (5) Nothing stored is handed out by reference ─────────────────────────────
  {
    _resetSharedReadCache();
    const original = [{ id: 1, marked: false }];
    const first = await getOrLoadShared("t", "k", async () => original, LIMITS);
    first.rows![0].marked = true;
    original[0].marked = true;
    const second = await getOrLoadShared("t", "k", async () => [], LIMITS);
    assert.equal(second.cache, "hit");
    assert.equal(
      second.rows![0].marked,
      false,
      "RED the door's callers mark and collapse rows in place — one viewer's edit must never reach the next",
    );
    // And a copy handed out FROM the cache is the caller's own too.
    second.rows![0].marked = true;
    const third = await getOrLoadShared("t", "k", async () => [], LIMITS);
    assert.equal(third.cache, "hit");
    assert.equal(third.rows![0].marked, false, "RED a cache hit must hand out copies, never the stored rows themselves");
  }

  // ── (6) Bounded: entry count and row budget, oldest out first ─────────────────
  {
    _resetSharedReadCache();
    const rows = (n: number) => async () => Array.from({ length: n }, (_, i) => ({ id: i }));
    await getOrLoadShared("t", "a", rows(1), LIMITS);
    await getOrLoadShared("t", "b", rows(1), LIMITS);
    await getOrLoadShared("t", "c", rows(1), LIMITS);
    await getOrLoadShared("t", "a", rows(1), LIMITS); // touch a, so b is now the oldest
    await getOrLoadShared("t", "d", rows(1), LIMITS);
    assert.equal((await getOrLoadShared("t", "b", rows(1), LIMITS)).cache, "miss", "the least recently used entry goes first");

    _resetSharedReadCache();
    const big = await getOrLoadShared("t", "big", rows(11), LIMITS);
    assert.equal(big.rows!.length, 11, "a load over the budget is still served whole");
    assert.equal((await getOrLoadShared("t", "big", rows(11), LIMITS)).cache, "miss", "but it is never stored");

    _resetSharedReadCache();
    await getOrLoadShared("t", "x", rows(6), LIMITS);
    await getOrLoadShared("t", "y", rows(6), LIMITS);
    assert.equal((await getOrLoadShared("t", "x", rows(6), LIMITS)).cache, "miss", "the row budget evicts the oldest");
  }

  // ── (7) The key reads the whole options object, in any key order ──────────────
  {
    assert.equal(sharedReadKey({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), sharedReadKey({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
    assert.equal(sharedReadKey({ a: 1, skip: undefined }), sharedReadKey({ a: 1 }));
    assert.notEqual(sharedReadKey({ dateFrom: "2026-10-01" }), sharedReadKey({ dateFrom: "2026-10-02" }));
  }

  // ── (8) ONLY a display reader opts in, and the door shares only the company window ─
  {
    const optIns = sourceFiles("src")
      .filter((path) => /reuseRecentWindow\s*:\s*true/.test(code(path)))
      .map((path) => relative(ROOT, join(ROOT, path)).replace(/\\/g, "/"))
      .sort();
    assert.deepEqual(
      optIns,
      ["src/lib/crm/sfe-field-analytics.ts"],
      "RED a new reader opted into the minute-old CRM copy — only a DISPLAY reader may, never one that decides money, a deduction, an approval or a notification. Classify it here first.",
    );

    const door = code("src/lib/crm/reads.ts");
    assert.match(door, /readWindowMaybeShared<Row>\(CRM_VISIT_WINDOWS, sharedKey, \(\) => readCompanyWindow/);
    assert.match(door, /readWindowMaybeShared<Row>\(CRM_CHECKIN_WINDOWS, sharedKey, \(\) => readCompanyWindow/);
    const keys = door.match(/sharedReadKey\(\{[^}]*\}\)/g) ?? [];
    assert.equal(keys.length, 2);
    for (const key of keys) {
      for (const part of ["excludedInList", "options", "pageSize", "projection"]) {
        assert.ok(key.includes(part), `RED the shared key must carry ${part} — a key missing an input serves one read's rows to another`);
      }
    }
    assert.match(door, /options\.reuseRecentWindow \? sharedReadKey/, "the copy is opt-in: no option, no sharing");
  }

  // ── (9) The app's own writes refresh the copy at once ─────────────────────────
  {
    const save = code("src/lib/phoenix-crm/server/visits.ts");
    const rpc = save.indexOf('callPhoenixCrm<Row>("phoenix_crm_save_visit"');
    const refresh = save.indexOf("refreshSharedCrmWindows(");
    assert.ok(rpc > 0 && refresh > rpc, "RED a saved Phoenix CRM visit must drop the minute-old copy, after the save");

    const poller = code("src/lib/crm/live-poller.ts");
    assert.match(poller, /rowsUpserted > 0 \|\| result\.checkinsUpserted > 0 \|\| result\.rowsDeleted > 0\) \{\s*refreshSharedCrmWindows\(/);
  }

  console.log("shared read cache: 9 blocks passed");
}
