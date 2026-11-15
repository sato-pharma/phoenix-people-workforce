import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { failuresSinceLastSuccess, loginThrottleMaxFailures } from "../src/lib/auth/login-throttle-policy.ts";

// 2026-11-15, HR seat: eight typos 11:31–11:33 Cairo, a CORRECT sign-in at 11:36:10, then two more
// typos at 11:36 on a second device. The account gate counted all ten failures in the 15-minute
// window, ignored the success between them, and refused her ("Too many failed login attempts")
// until 11:46. A correct password proves the person, so only failures after it may count.
export function runLoginLockoutSuccessResetTests() {
  const failures = [
    "2026-11-15T09:36:48.317+00:00",
    "2026-11-15T09:36:34.386+00:00",
    "2026-11-15T09:33:53.022+00:00",
    "2026-11-15T09:33:47.524+00:00",
    "2026-11-15T09:32:39.687+00:00",
    "2026-11-15T09:32:10.232+00:00",
    "2026-11-15T09:31:38.427+00:00",
    "2026-11-15T09:31:30.210+00:00",
    "2026-11-15T09:31:21.058+00:00",
    "2026-11-15T09:31:13.327+00:00",
  ];
  const success = "2026-11-15T09:36:10.759+00:00";

  assert.equal(failures.length, loginThrottleMaxFailures, "the replay holds exactly the limit's worth of failures");
  assert.equal(failuresSinceLastSuccess(failures, success), 2, "only the two typos after her correct sign-in still count");
  assert.ok(
    failuresSinceLastSuccess(failures, success) < loginThrottleMaxFailures,
    "a person who signed in correctly inside the window is not locked out by the typos before it",
  );

  // The guessing attack the gate exists for keeps the full count.
  assert.equal(failuresSinceLastSuccess(failures, null), failures.length, "with no success every failure counts");
  assert.equal(failuresSinceLastSuccess(failures, undefined), failures.length, "a missing success counts no success");
  assert.equal(failuresSinceLastSuccess(failures, "not a time"), failures.length, "an unreadable success time fails closed");
  assert.equal(
    failuresSinceLastSuccess(failures, "2026-11-15T09:30:00.000+00:00"),
    failures.length,
    "a success BEFORE all the failures forgives none of them",
  );
  assert.equal(failuresSinceLastSuccess(failures, "2026-11-15T09:40:00.000+00:00"), 0, "a success after every failure clears them all");
  assert.equal(failuresSinceLastSuccess([null, "garbage"], success), 2, "a failure whose time cannot be read still counts");
  assert.equal(failuresSinceLastSuccess([], success), 0, "no failures, nothing counts");

  // The rule only protects anyone if the sign-in gate actually asks it.
  const source = readFileSync("src/lib/auth/audit.ts", "utf8");
  const gate = source.slice(
    source.indexOf("export async function isLoginRateLimited"),
    source.indexOf("async function countAccountsSignedInFromIp"),
  );
  assert.ok(gate.length > 0, "the gate was found in audit.ts");
  assert.match(
    gate,
    /failuresSinceLastSuccess\(failedAt, lastSuccessAt\) >= loginThrottleMaxFailures/,
    "the account gate must refuse on failures since the last success, not on every failure in the window",
  );
  assert.match(
    gate,
    /\.eq\("login_id", rateLimitKey\)\s*\.eq\("success", true\)\s*\.gte\("attempted_at", threshold\)\s*\.order\("attempted_at", \{ ascending: false \}\)\s*\.limit\(1\)/,
    "the gate must read this account's latest successful sign-in in the window",
  );
  assert.match(
    gate,
    /\.eq\("success", false\)\s*\.gte\("attempted_at", threshold\)\s*\.order\("attempted_at", \{ ascending: false \}\)\s*\.limit\(loginThrottleMaxFailures\)/,
    "the gate must read the latest failures, enough to reach the limit",
  );
  assert.doesNotMatch(
    gate,
    /loginAttemptsResult\.count \?\? 0\) >= loginThrottleMaxFailures/,
    "the old count that ignored a correct sign-in must not come back",
  );
  // The network gate stays a plain count: one account's success does not vouch for an address.
  assert.match(
    gate,
    /\.eq\("ip", ip\)\s*\.eq\("success", false\)\s*\.gte\("attempted_at", threshold\)/,
    "the network gate still counts every failure from the address",
  );
}
