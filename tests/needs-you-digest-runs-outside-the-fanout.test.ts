import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE BOARD'S LANES CANNOT PROTECT IT FROM THE ROUTE THAT CARRIES IT.
//
// `/api/notifications/daily` fires at 06:36 Cairo and runs 31 sub-jobs. The Needs You digest is
// one of them, and the board it loads is not one query — it is 22 sources behind its own two-lane
// scheduler (heavy ONE at a time, light four, each source racing an 8-second budget). Those lanes
// were built on 2026-10-09 because an unbounded `Promise.all` was making sources starve each
// other; measured alone against production the worst source took 5,516 ms and 0 of 22 exceeded
// the budget.
//
// Run as a passenger inside the route's own unbounded 31-way `Promise.all`, the same thing
// happened one level up. Measured on production from the owner's delivered digests, 06:36 Cairo,
// 15 consecutive mornings 2026-10-09 → 2026-10-23: every single run opened with "Could not be
// read", 1-5 sources ambered per run, and the two `heavy` ones — "Other approvals inbox" and
// "Published closings that have moved" — failed on every one of them. On 23 Oct it also lost
// "Payroll months waiting to publish", so that morning's digest carried no payroll line at all.
//
// The fix is the caller, not the board: the digest is awaited ON ITS OWN before the fan-out, and
// its settled result is handed to the fan-out at its own position so no position below shifts.
//
// 🔴 The two changes that would silently bring the defect back are (a) moving the call into the
// array again and (b) leaving the call outside but having the array call it a SECOND time. Each
// assertion below is written as the change that would break it. Raising the 8-second budget or
// widening a lane is NOT a fix — it trades the board's honesty for a green digest — so nothing
// here pins a timing number.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_URL = new URL("../app/api/notifications/daily/route.ts", import.meta.url);

/** The opening of the 31-way fan-out: the FIRST destructured `await Promise.all([` in the file. */
const FAN_OUT_OPENS = "] = await Promise.all([";

export function runNeedsYouDigestRunsOutsideTheFanoutTests() {
  // Read and strip INSIDE the test, never at module load — a pin that reads its target while the
  // module is being imported cannot be break-tested in the same process.
  const code = stripComments(readFileSync(ROUTE_URL, "utf8"));

  const fanOutAt = code.indexOf(FAN_OUT_OPENS);
  assert.notEqual(
    fanOutAt,
    -1,
    "RED the 31-way destructured Promise.all is gone from the daily route — this pin has lost its subject and proves nothing until it is rewritten",
  );

  // ── The digest is called exactly once ─────────────────────────────────────
  // A call left in the array beside the awaited one would run the board TWICE: two Telegram
  // messages, and the second one back inside the contention this change exists to remove.
  const calls = [...code.matchAll(/runNeedsYouDailyDigest\(/g)].map((m) => m.index ?? -1);
  assert.equal(
    calls.length,
    1,
    `RED runNeedsYouDailyDigest() is called ${calls.length} times — the board must be run once, outside the fan-out, and its settled result handed in`,
  );

  // ── And that one call is awaited BEFORE the fan-out opens ─────────────────
  assert.ok(
    calls[0] < fanOutAt,
    "RED the Needs You digest is being called from inside the 31-way Promise.all again — its 22 sources then spend their 8-second budgets queueing behind 30 sibling jobs, and the owner's 06:36 digest loses the sources it could not read",
  );

  // ── The fan-out carries the settled result, at the digest's own position ──
  const settledAt = code.indexOf("Promise.resolve(needsYouDailyResult)");
  assert.notEqual(
    settledAt,
    -1,
    "RED the fan-out no longer carries the already-settled digest result — positions 26 and below have shifted, which is the off-by-one that has silently mis-captured this route's results twice before",
  );
  assert.ok(
    settledAt > fanOutAt,
    "RED the settled digest result sits outside the fan-out array, so position 26 is filled by whatever follows it",
  );

  // ── The destructure still names the job, so the run summary still counts it ─
  assert.match(
    code,
    /\n\s*needsYouDailyDigest,/,
    "RED the destructured name is gone — the run summary, the response body and the dead man's switch all read this job by that name",
  );
}
