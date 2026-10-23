import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECTORY_REFRESH_BEHIND_MS,
  directoryCacheDisposition,
  mayServeStaleDirectory,
  STALE_CACHE_MAX_AGE,
} from "../src/lib/employees/employee-directory.ts";
import { stripComments } from "./support/comment-strip.ts";

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

const CACHE_TTL_MS = 30_000; // the module's CACHE_TTL, restated so a change to it fails here

const MODULE_URL = new URL("../src/lib/employees/employee-directory.ts", import.meta.url);

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
    3,
    `RED every failure path must serve stale data through the ONE bounded helper — the directory, its rows and the lean name roster — a direct \`cache.data\` return is the unbounded read this closes (found ${staleServings} call sites)`,
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
    /if \(ageMs < CACHE_TTL\) return "fresh";/,
    "RED the fresh path must still gate on CACHE_TTL — the stale bound is a fallback rule, not a replacement for it",
  );

  // ── Refresh behind (2026-10-16): a poll just past the TTL is answered, not made to wait ──
  // The sidebar polls every 30 s, which is also CACHE_TTL, so each poll found the copy one tick expired and waited
  // out the whole multi-table load (about 2 s at the 95th percentile in Sentry). Within a bounded window past the
  // TTL the copy is served and a reload runs behind it.
  assert.equal(directoryCacheDisposition(0), "fresh");
  assert.equal(directoryCacheDisposition(CACHE_TTL_MS - 1), "fresh");
  assert.equal(directoryCacheDisposition(CACHE_TTL_MS), "refresh-behind", "the poll that lands exactly on the TTL is the one this exists for");
  assert.equal(directoryCacheDisposition(CACHE_TTL_MS + DIRECTORY_REFRESH_BEHIND_MS - 1), "refresh-behind");
  assert.equal(
    directoryCacheDisposition(CACHE_TTL_MS + DIRECTORY_REFRESH_BEHIND_MS),
    "reload",
    "RED past the window the caller waits for a real load — the roster is never served indefinitely stale",
  );
  assert.equal(directoryCacheDisposition(6 * 60 * 60 * 1000), "reload");
  assert.equal(directoryCacheDisposition(-5_000), "fresh", "a clock step backwards reads as age 0");
  assert.equal(directoryCacheDisposition(Number.NaN), "reload", "an unusable age cannot be proven recent");
  assert.ok(
    DIRECTORY_REFRESH_BEHIND_MS <= 2 * 60 * 1000,
    `RED the refresh-behind window must stay under two minutes — salaries and managers are stated as fact (got ${DIRECTORY_REFRESH_BEHIND_MS}ms)`,
  );

  // A write drops the copy AND stops a load already running from putting its older answer back.
  assert.match(code, /directoryGeneration \+= 1;\s*directoryCache = null;/, "RED invalidation must bump the generation before it drops the cache");
  const stampGuards = [...code.matchAll(/if \(generation === directoryGeneration\)/g)].length;
  assert.equal(
    stampGuards,
    3,
    `RED all three caches — the directory, its rows and the lean name roster — must refuse to stamp a load that began before an invalidation (found ${stampGuards})`,
  );
  // A pass at probation makes the person payroll-eligible, and payroll reads eligibility from the directory.
  const probationDecision = stripComments(readFileSync(new URL("../src/lib/probation/intelligence/decision.ts", import.meta.url), "utf8"));
  assert.match(
    probationDecision,
    /payroll_eligible: true[\s\S]*?if \(error\) throw error;\s*invalidateEmployeeDirectoryCache\(\);/,
    "RED a pass at probation must drop the cached directory, or a payroll draft in the next 90 s leaves the new permanent employee out",
  );
  assert.equal(
    [...code.matchAll(/loadDirectoryShared\(\)\.catch\(\(\) => undefined\)|loadShared\(\)\.catch\(\(\) => undefined\)/g)].length,
    2,
    "RED a reload run behind a served copy must swallow its own failure — nobody awaits it and an unhandled rejection kills the process",
  );

  // ── THE LEAN NAME ROSTER (2026-10-23) ──────────────────────────────────────────────────────────
  // Three callers in src/lib/action-center/service.ts were loading the WHOLE directory to turn an
  // HR id into a name — twelve reads and a 511 KB payload, one of them to name a SINGLE deep-linked
  // item. Measured against production the day it changed: 1,800 ms cold against 164 ms, 511.6 KB
  // against 65.9 KB, and 112 of 112 people resolving to the identical name in both directions.
  //
  // The saving is only safe while two things hold, and each has a silent failure mode:
  //   (1) the roster decides membership with the directory's OWN filter. A resigned employee is
  //       absent from the directory on purpose, so a resignation item falls back to the name stored
  //       on the request — a roster that quietly included leavers would RENAME people on the one
  //       screen where they are leaving.
  //   (2) the select carries every column that filter reads. A column it cannot see does not throw;
  //       it admits somebody the directory withholds, and nothing on screen says so.
  assert.match(
    code,
    /export function isActiveDirectoryEmployee\(employee: DirectoryMembershipFields\)/,
    "RED directory membership must be decided through DirectoryMembershipFields — the Pick is what stops the lean roster's select drifting from the real filter",
  );

  const rosterSelectStart = code.indexOf("const NAME_ROSTER_SELECT");
  assert.ok(rosterSelectStart > 0, "RED NAME_ROSTER_SELECT not found — the lean name roster read is gone");
  const rosterSelect = code.slice(rosterSelectStart, code.indexOf("].join", rosterSelectStart));
  for (const column of [
    "hr_id",
    "full_name",
    "nickname",
    "job_title",
    "employment_status",
    "payroll_eligible",
    "organogram_visible",
    "position_id",
    "line_id",
  ]) {
    assert.ok(
      rosterSelect.includes(column),
      `RED the name roster select must read ${column} — isActiveDirectoryEmployee decides on it, and a column the select omits silently admits somebody the directory withholds`,
    );
  }
  for (const embed of ["positions!employees_position_id_fkey(title)", "lines!employees_line_id_fkey(name)"]) {
    assert.ok(
      rosterSelect.includes(embed),
      `RED the name roster select must embed ${embed} — classifyEmployeeNode reads the position title and the line name, so without them a vacancy or placeholder node classifies as a live employee`,
    );
  }

  const rosterFetchStart = code.indexOf("async function fetchEmployeeNameRoster");
  assert.ok(rosterFetchStart > 0, "RED fetchEmployeeNameRoster not found");
  const rosterFetch = code.slice(rosterFetchStart, code.indexOf("export async function getEmployeeNameRoster", rosterFetchStart));
  assert.match(
    rosterFetch,
    /if \(!isActiveDirectoryEmployee\(candidate\)\) continue;/,
    "RED every roster row must pass the directory's own membership filter, never a second copy of it",
  );
  assert.match(
    rosterFetch,
    /return directoryNameRoster\(await getEmployeeDirectory\(\)\);/,
    "RED a failed roster select must fall back to the FULL directory, never to a laxer filter — a wrong name is worse than a slow one",
  );
  assert.match(
    code,
    /directoryCacheDisposition\(Date\.now\(\) - directoryCache\.timestamp\) === "fresh"/,
    "RED the roster must reuse a directory already in cache — otherwise a page that holds one pays a second read for names it already has",
  );

  // The three callers this was built for must not walk back to the full directory.
  const actionCenter = stripComments(readFileSync(new URL("../src/lib/action-center/service.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(
    actionCenter,
    /getEmployeeDirectory\(/,
    "RED the action inbox must resolve names through getEmployeeNameRoster — the full directory is twelve reads and 511 KB for a display name, paid inside this board's 8-second per-source budget",
  );
  assert.equal(
    [...actionCenter.matchAll(/getEmployeeNameRoster\(/g)].length,
    3,
    "RED all three name lookups in the action centre — the awaiting-action fan-out, the decided-history feed and the deep-link builder — must read the roster",
  );
}
