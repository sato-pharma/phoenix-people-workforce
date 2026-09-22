import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mayServeStaleDirectory, STALE_CACHE_MAX_AGE } from "../src/lib/employees/employee-directory.ts";

// ─────────────────────────────────────────────────────────────────────────────
// TWO defects, one of which compounded.
//
// (1) UNBOUNDED STALENESS. The fresh path checked `now - timestamp < CACHE_TTL` (30s). The FAILURE
//     paths checked nothing: on a timeout they returned `cache.data` without looking at
//     `timestamp` at all, so an entry from minutes or hours ago was served as current. The
//     directory carries headcount, managers, job titles and salary figures, and every page that
//     renders them states them as fact — nothing on screen separates "as of now" from "as of this
//     morning".
//
// (2) THE CACHE RENEWED ITSELF OFF ITS OWN STALE CONTENTS. Inside fetchEmployeeDirectory, the
//     fallback-select failure branch RETURNED `directoryCache.data` — as a successful load. The
//     `.then()` in getEmployeeDirectory writes every successful load into the cache with a fresh
//     `Date.now()`. So each failing call re-stamped the old data as new: the 30-second TTL could
//     never expire while the query kept failing, and the cache was refreshed indefinitely off
//     itself. That is why (2) is worse than (1) — it is not a stale read, it is a cache that
//     cannot age.
//
// The fix puts the decision in ONE place, bounded, where serving stale data cannot refresh the
// timestamp. This test pins the age rule behaviourally and pins the two structural facts that
// stop either defect walking back in.
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_URL = new URL("../src/lib/employees/employee-directory.ts", import.meta.url);

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

export async function runEmployeeDirectoryStaleBoundTests() {
  const now = 1_800_000_000_000;

  // ── The age rule itself ───────────────────────────────────────────────────
  assert.equal(
    mayServeStaleDirectory(now - 1_000, now),
    true,
    "a one-second-old copy must still answer a failed load — riding out a blip is the point of the fallback",
  );
  assert.equal(
    mayServeStaleDirectory(now - STALE_CACHE_MAX_AGE, now),
    true,
    "exactly at the bound is inside it — the comparison is <=, so the boundary is not a coin toss",
  );
  assert.equal(
    mayServeStaleDirectory(now - STALE_CACHE_MAX_AGE - 1, now),
    false,
    "RED one millisecond past the bound must be refused — an unbounded fallback is the defect this closes",
  );
  assert.equal(
    mayServeStaleDirectory(now - 6 * 60 * 60 * 1000, now),
    false,
    "RED a six-hour-old roster must NEVER be served as current — headcount, managers and salaries are stated as fact",
  );

  // A clock step backwards must not turn into an outage.
  assert.equal(
    mayServeStaleDirectory(now + 30_000, now),
    true,
    "a future timestamp reads as age 0 — a clock adjustment is not a reason to refuse a fresh entry",
  );
  assert.equal(
    mayServeStaleDirectory(Number.NaN, now),
    false,
    "an unusable timestamp cannot be proven recent, so it must not be served",
  );

  // The bound must stay a real bound, not a number large enough to be no bound at all.
  assert.ok(
    STALE_CACHE_MAX_AGE > 60_000 && STALE_CACHE_MAX_AGE <= 30 * 60 * 1000,
    `RED STALE_CACHE_MAX_AGE must stay between a minute and half an hour — outside that it is either useless or not a bound (got ${STALE_CACHE_MAX_AGE}ms)`,
  );

  const code = stripComments(readFileSync(MODULE_URL, "utf8"));

  // ── Defect (2): the fetch must never hand stale rows to the success path ──
  // This is the assertion that matters most. `fetchEmployeeDirectory` returning `directoryCache.data`
  // is what let a failing query re-stamp old data as fresh, forever.
  const fetchAt = code.indexOf("async function fetchEmployeeDirectory(");
  assert.notEqual(fetchAt, -1, "fetchEmployeeDirectory must still exist — this test is pinned to it");
  const fetchBody = code.slice(fetchAt, code.indexOf("\nasync function ", fetchAt + 1));
  assert.doesNotMatch(
    fetchBody,
    /return directoryCache\.data/,
    "RED fetchEmployeeDirectory must not RETURN the cache — a successful-looking return is written back with a fresh timestamp, so the cache renews itself off its own stale contents and never ages",
  );

  // ── Defect (1): every failure path goes through the bounded helper ────────
  assert.match(
    code,
    /function serveStaleOnFailure<T>\(/,
    "the bounded helper must exist — it is the one place the stale decision is allowed to be made",
  );
  const staleServings = [...code.matchAll(/serveStaleOnFailure\(/g)].length;
  assert.equal(
    staleServings,
    2,
    `RED both failure paths must serve stale data through the ONE bounded helper — a direct \`cache.data\` return is the unbounded read this closes (found ${staleServings} call sites)`,
  );
  assert.doesNotMatch(
    code,
    /if \(isEmployeeDirectoryTimeout\(error\) && (directoryCache|staleCache)\)/,
    "RED the old unbounded timeout fallbacks must not come back — they returned cached data without ever reading its timestamp",
  );

  // ── The fresh path keeps its own, much tighter, TTL ───────────────────────
  // The two bounds are not interchangeable: 30s decides "is this current", 10min decides "will
  // this do instead of failing". Collapsing them either serves half-hour-old data as current or
  // refuses a perfectly good fallback.
  assert.match(
    code,
    /now - directoryCache\.timestamp < CACHE_TTL/,
    "RED the fresh path must still gate on CACHE_TTL — the stale bound is a fallback rule, not a replacement for it",
  );
}
