import assert from "node:assert/strict";

import { backoffMs, shouldDeadLetter } from "../src/lib/recruitment/inbound/intake-queue.ts";
import { emailQueueKey } from "../src/lib/recruitment/inbound/email-poll-planner.ts";

export function runRecruitmentInboundQueueTests() {
  // --- backoffMs: exponential, capped -----------------------------------------------------------
  // `attempts` is the post-claim attempt number (the claim RPC increments before the worker runs),
  // so attempt 1's failure waits the base delay, then it doubles.
  assert.equal(backoffMs(1), 30_000, "first failure waits the base 30s");
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(3), 120_000);
  assert.equal(backoffMs(4), 240_000);
  assert.equal(backoffMs(10), 60 * 60_000, "backoff is capped at 1h so a poison message doesn't wait days");
  assert.equal(backoffMs(0), 30_000, "attempts below 1 clamp to the base, never a zero/negative wait");
  assert.equal(backoffMs(-5), 30_000);

  // --- shouldDeadLetter: the retry boundary -----------------------------------------------------
  assert.equal(shouldDeadLetter(1, 5), false);
  assert.equal(shouldDeadLetter(4, 5), false, "still has one attempt left");
  assert.equal(shouldDeadLetter(5, 5), true, "used up its attempts -> dead-letter, not an infinite loop");
  assert.equal(shouldDeadLetter(6, 5), true, "a re-claimed stale row past the limit is still terminal");

  // --- emailQueueKey: UIDVALIDITY-scoped dedupe key ---------------------------------------------
  // UIDVALIDITY is baked in so a server-side mailbox rebuild (UIDs reset to 1) can't map a fresh
  // message onto an old message's key and have the unique index silently drop it as a duplicate.
  assert.equal(emailQueueKey("hr", BigInt(1742203931), 20909), "email:hr:1742203931:20909");
  assert.equal(emailQueueKey("hr:junk", 55, 12), "email:hr:junk:55:12", "the junk folder keeps its own key namespace");
  assert.notEqual(
    emailQueueKey("hr", 1, 100),
    emailQueueKey("hr", 2, 100),
    "the same UID under a new UIDVALIDITY is a different key, so a rebuilt mailbox re-ingests rather than dropping",
  );
}
