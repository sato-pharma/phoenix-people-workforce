import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loginIpFailureLimit,
  loginIpThrottleMaxFailures,
  loginSharedNetworkMaxFailures,
  loginThrottleMaxFailures,
} from "../src/lib/auth/login-throttle-policy.ts";

// 2026-09-16: fifteen typos from five colleagues on one office network in seven minutes refused
// sign-in to EVERYONE on it, including a new hire with no failed attempt of their own, because the
// network gate counted an office as one attacker. An address where different colleagues have already
// signed in is a shared network and gets room for each of them; an unknown address stays strict.
export function runLoginSharedNetworkThrottleTests() {
  // The incident, replayed with its real numbers: 15 failures from an address nine different
  // colleagues had signed in from that day.
  assert.ok(
    15 < loginIpFailureLimit(9),
    "an office where nine colleagues signed in today must not be locked out by fifteen typos",
  );
  assert.equal(loginIpFailureLimit(9), 9 * loginThrottleMaxFailures, "each colleague gets the room their own account lock allows");

  // The attack the gate exists for keeps the strict limit.
  assert.equal(loginIpThrottleMaxFailures, 15, "the strict network limit stays fifteen failures");
  assert.equal(loginIpFailureLimit(0), loginIpThrottleMaxFailures, "an address nobody has signed in from is refused at fifteen failures");
  assert.ok(15 >= loginIpFailureLimit(0), "fifteen failures from an unknown address are still refused");
  assert.equal(loginIpFailureLimit(1), loginIpThrottleMaxFailures, "one account signing in is not a shared network");
  assert.equal(loginIpFailureLimit(500), loginSharedNetworkMaxFailures, "no address, however busy, gets more than the ceiling");
  assert.equal(loginSharedNetworkMaxFailures, 150, "the shared-network ceiling stays 150 failures in the window");
  assert.equal(loginIpFailureLimit(Number.NaN), loginIpThrottleMaxFailures, "an unreadable count fails closed to the strict limit");
  assert.equal(loginIpFailureLimit(-3), loginIpThrottleMaxFailures, "a negative count fails closed to the strict limit");

  // The limit only protects anyone if the sign-in gate actually asks it, and only SUCCESSFUL
  // sign-ins may prove an address is shared (failures are exactly what an attacker can produce).
  const source = readFileSync("src/lib/auth/audit.ts", "utf8");
  const gate = source.slice(source.indexOf("export async function isLoginRateLimited"));
  assert.match(gate, /ipFailures >= loginIpFailureLimit\(accountsSignedInFromIp\)/, "the network gate must refuse at the shared-network limit, not a fixed count");
  assert.doesNotMatch(gate, /count \?\? 0\) >= loginIpThrottleMaxFailures\) \{\s*return true;/, "the fixed fifteen-failure office lockout must not come back");
  const counter = source.slice(source.indexOf("async function countAccountsSignedInFromIp"));
  assert.match(counter, /\.eq\("ip", ip\)\s*\.eq\("success", true\)/, "only successful sign-ins from that address may count as colleagues");
  assert.match(counter, /return 0;/, "a failed lookup must count zero colleagues and keep the strict limit");
}
