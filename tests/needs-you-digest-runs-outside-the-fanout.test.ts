import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DAILY_JOBS } from "../src/lib/scheduled-jobs/daily-jobs.ts";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE BOARD'S LANES CANNOT PROTECT IT FROM THE REQUEST THAT CARRIES IT.
//
// Until 13 Nov 2026 `/api/notifications/daily` fired at 06:36 Cairo and ran 31 sub-jobs. The Needs
// You digest was one of them, and the board it loads is not one query — it is 22 sources behind its
// own two-lane scheduler (heavy ONE at a time, light four, each source racing an 8-second budget).
// Those lanes were built on 2026-10-09 because an unbounded `Promise.all` was making sources starve
// each other; measured alone against production the worst source took 5,516 ms and 0 of 22 exceeded
// the budget.
//
// Run as a passenger inside the route's own unbounded 31-way `Promise.all`, the same thing happened
// one level up. Measured on production from the owner's delivered digests, 06:36 Cairo, 15
// consecutive mornings 2026-10-09 → 2026-10-23: every single run opened with "Could not be read",
// 1-5 sources ambered per run, and the two `heavy` ones — "Other approvals inbox" and "Published
// closings that have moved" — failed on every one of them. On 23 Oct it also lost "Payroll months
// waiting to publish", so that morning's digest carried no payroll line at all.
//
// The first fix (24 Oct 2026) awaited the digest on its own before the fan-out. Since 13 Nov 2026
// there is no fan-out: every morning job has its own schedule, minute and request
// (`/api/cron/daily/<job>`), and the digest is the job `needs-you-daily-digest`, FIRST, at 06:36.
//
// 🔴 The changes that would silently bring the defect back are (a) a loop or `Promise.all` in the
// route that runs the jobs, (b) another job on the digest's minute, and (c) the digest being called
// a second time from anywhere in the morning jobs. Each assertion below is written as the change
// that would break it. Raising the 8-second budget or widening a lane is NOT a fix — it trades the
// board's honesty for a green digest — so nothing here pins a timing number.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_URL = new URL("../app/api/cron/daily/[job]/route.ts", import.meta.url);
const RUNNERS_URL = new URL("../app/api/cron/daily/_lib/daily-job-runners.ts", import.meta.url);
const DIGEST = "needs-you-daily-digest";

export function runNeedsYouDigestRunsOutsideTheFanoutTests() {
  // Read and strip INSIDE the test, never at module load — a pin that reads its target while the
  // module is being imported cannot be break-tested in the same process.
  const route = stripComments(readFileSync(ROUTE_URL, "utf8"));
  const runners = stripComments(readFileSync(RUNNERS_URL, "utf8"));

  // ── The route runs ONE job per request ───────────────────────────────────
  assert.doesNotMatch(
    route,
    /Promise\.(all|allSettled)\(/,
    "RED the morning jobs' route runs jobs together again — the digest's 22 sources then spend their 8-second budgets queueing behind sibling jobs, and the owner's 06:36 digest loses the sources it could not read",
  );
  assert.doesNotMatch(
    route,
    /\bfor\s*\(|\.forEach\(/,
    "RED the morning jobs' route loops over the jobs — one request must run exactly one job",
  );

  // ── The digest is its own job: first, at 06:36, alone on its minute ───────
  const digest = DAILY_JOBS.find((job) => job.key === DIGEST);
  assert.ok(digest, `RED the Needs You digest is no longer a morning job of its own ("${DIGEST}")`);
  assert.equal(DAILY_JOBS[0]?.key, DIGEST, "RED the digest is no longer the first job of the morning");
  assert.deepEqual([digest.hour, digest.minute], [6, 36], "RED the digest has left 06:36 Cairo, the minute he reads it");
  const sharing = DAILY_JOBS.filter((job) => job !== digest && job.hour === digest.hour && job.minute === digest.minute);
  assert.deepEqual(sharing.map((job) => job.key), [], "RED another morning job shares the digest's minute — two requests then contend for the database at the same instant");

  // ── The digest is called exactly once, from its own runner ────────────────
  const calls = [...runners.matchAll(/runNeedsYouDailyDigest\(/g)];
  assert.equal(
    calls.length,
    1,
    `RED runNeedsYouDailyDigest() is called ${calls.length} times in the morning jobs — the board must be run once, by its own job`,
  );
  const ownRunner = runners.slice(runners.indexOf(`"${DIGEST}": {`), runners.indexOf(`"${DIGEST}": {`) + 400);
  assert.match(ownRunner, /runNeedsYouDailyDigest\(\)/, "RED the digest's call is not inside its own job's runner");

  // ── Its answer still names the result, as the old route's answer did ──────
  assert.match(
    ownRunner,
    /resultName: "needsYouDailyDigest"/,
    "RED the result name is gone — the answer a person reads with ?wait=1 names this job's result by it",
  );
}
