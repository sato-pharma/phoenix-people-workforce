import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FINISHED_SWEEP_QUIET_MS,
  shouldCloseSweptSession,
} from "../src/lib/recruitment/inbound/whatsapp-classify-session.ts";

/**
 * Conversations that answered every question but were never marked finished must repair themselves.
 *
 * `finishSession` is the only thing that closes a conversation. Anything that records the last fixed
 * answer without reaching that call leaves a row open for ever — fully answered, going nowhere, and
 * swallowing every later CV from that number. Production on 2026-09-02 held 39 of them: 31 whose
 * answers a backfill had written onto the candidate without closing the row, and 8 that answered
 * everything and never reached a candidate at all, with a candidate available the whole time.
 *
 * The rule that matters most here is the one that does NOT act: a row whose answers never landed is
 * left open. The session table is the only place a typed salary exists until it is copied onto the
 * candidate, so closing an unapplied row destroys the answer.
 */
export function runWhatsAppFinishedSweepTests() {
  // ── Never close a row whose answers did not land ───────────────────────────────────────────────
  assert.equal(
    shouldCloseSweptSession({ appliedAt: null, appliedNow: false }),
    false,
    "the sweep would close a conversation whose answers never reached a candidate, destroying them — the session table is the only copy",
  );
  assert.equal(
    shouldCloseSweptSession({ appliedAt: "2026-09-02T00:31:41Z", appliedNow: false }),
    true,
    "a row already applied to a candidate is finished and must not stay open blocking that sender",
  );
  assert.equal(
    shouldCloseSweptSession({ appliedAt: null, appliedNow: true }),
    true,
    "a row the sweep has just applied is finished and must be closed in the same pass",
  );

  // Long enough that a conversation which answered seconds ago and is still inside finishSession is
  // never stolen; short enough to repair within one working session.
  assert.ok(
    FINISHED_SWEEP_QUIET_MS >= 10 * 60 * 1000,
    "the quiet window is short enough to race a finishSession that is still in flight",
  );

  const source = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-classify-session.ts", import.meta.url),
    "utf8",
  );

  // ── Scope: the last fixed question only ────────────────────────────────────────────────────────
  // `step = 'salary'` is what keeps the admin-defined `extra` loop out of the sweep's reach. A
  // conversation in that loop is legitimately open and is finished by the loop itself; closing one
  // would drop the applicant mid-question and lose the extra answers with it.
  assert.ok(
    /\.eq\("step",\s*"salary"\)/.test(source),
    "the sweep is no longer scoped to the salary step, so it can close a conversation still inside the admin-defined extra-question loop",
  );
  assert.ok(
    /\.not\("expected_salary",\s*"is",\s*null\)/.test(source),
    "the sweep no longer requires the last question to have been answered, so it can close a conversation still waiting on one",
  );
  assert.ok(
    /\.lt\("updated_at",\s*quietBefore\)/.test(source),
    "the sweep lost its quiet window and can now race a finishSession that is still in flight",
  );
  assert.ok(
    /\.limit\(FINISHED_SWEEP_MAX_PER_TICK\)/.test(source),
    "the sweep is unbounded, so one backlog can turn a single intake tick into an unbounded run",
  );

  // ── Silent to the applicant, by design ─────────────────────────────────────────────────────────
  // These rows are hours or days old and their 24-hour window is shut, so a thank-you would fail as
  // `window_closed` — and routing the sweep through finishSession would fire the whole backlog at
  // the owner's Telegram in one tick.
  assert.ok(
    /await closeSession\(row\.id, "swept_finished"\)/.test(source),
    "the sweep no longer closes rows directly",
  );
  assert.equal(
    /finishSession\(row/.test(source),
    false,
    "the sweep routes through finishSession, which messages the applicant and mirrors every swept row to the owner's Telegram",
  );

  // ── The wiring ─────────────────────────────────────────────────────────────────────────────────
  // The sweep repairs nothing unless something calls it. It rides the existing intake tick rather
  // than a new cron job.
  const workerSource = readFileSync(
    new URL("../src/lib/recruitment/inbound/intake-worker.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    /await sweepFinishedClassifications\(\)\.catch\(\(\) => \{\}\)/.test(workerSource),
    "the intake tick no longer runs the finished-conversation sweep, so a conversation that never reached finishSession stays open for ever",
  );
}
