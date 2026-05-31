import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  clearSessionActivity,
  markSessionActivity,
  phoenixLastActivityStorageKey,
  phoenixSessionTimeoutReason,
  readSessionActivityAt,
} from "../src/lib/auth/client-session.ts";
import {
  createSessionToken,
  sessionIdleTimeoutSecondsForRole,
  verifySessionToken,
} from "../src/lib/auth/session-token.ts";
import {
  ACTIVE_EMPLOYMENT_STATUSES,
  evaluateEmployeeLifecycleGate,
  isTerminalEmploymentStatus,
} from "../src/lib/auth/session-lifecycle.ts";

function createMemoryStorage() {
  const values = new Map<string, string>();

  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">;
}

export function runAuthSessionTests() {
  process.env.PHOENIX_AUTH_SECRET = process.env.PHOENIX_AUTH_SECRET || "test-session-secret";

  assert.equal(sessionIdleTimeoutSecondsForRole("Employee"), 15 * 60);
  assert.equal(sessionIdleTimeoutSecondsForRole("Super Admin"), 15 * 60);

  const token = createSessionToken({
    hrId: "B-67",
    loginId: "B-67",
    maxAgeSeconds: sessionIdleTimeoutSecondsForRole("Employee"),
    role: "Employee",
    sessionId: "session-1",
    sessionVersion: 1,
  });
  const payload = verifySessionToken(token);

  assert.ok(payload);
  assert.equal(payload.loginId, "B-67");
  assert.equal(payload.exp - payload.iat, 15 * 60);

  const storage = createMemoryStorage();
  assert.equal(phoenixSessionTimeoutReason, "session-timeout");
  assert.equal(readSessionActivityAt(storage), null);
  storage.setItem(phoenixLastActivityStorageKey, "not-a-date");
  assert.equal(readSessionActivityAt(storage), null);
  markSessionActivity(storage, 1_800_000_000_000);
  assert.equal(readSessionActivityAt(storage), 1_800_000_000_000);
  clearSessionActivity(storage);
  assert.equal(readSessionActivityAt(storage), null);

  // ===========================================================================
  // WP-3: read-time session lifecycle governance.
  // ===========================================================================

  // Active employee statuses keep access (no terminal rejection).
  assert.equal(ACTIVE_EMPLOYMENT_STATUSES.has("active"), true, "active is an allowed status");
  assert.equal(ACTIVE_EMPLOYMENT_STATUSES.has("on_leave"), true, "on_leave is an allowed status");
  assert.equal(isTerminalEmploymentStatus("active"), false, "active employee + active app user is allowed");
  assert.equal(isTerminalEmploymentStatus("on_leave"), false, "on-leave employee remains allowed");
  assert.equal(isTerminalEmploymentStatus("ACTIVE"), false, "status check is case-insensitive");

  // Terminal employee statuses are denied even when the app user is still active.
  assert.equal(isTerminalEmploymentStatus("resigned"), true, "resigned employee + active app user is denied");
  assert.equal(isTerminalEmploymentStatus("terminated"), true, "terminated employee + active app user is denied");
  assert.equal(isTerminalEmploymentStatus("not_renewed"), true, "non-renewed employee is denied");
  assert.equal(isTerminalEmploymentStatus("inactive"), true, "inactive employee is denied");
  assert.equal(isTerminalEmploymentStatus(" Resigned "), true, "status is trimmed before comparison");

  // Missing / unset status must NOT lock out (unlinked or legacy rows stay allowed
  // so the rule can only tighten access for confirmed-terminal employees).
  assert.equal(isTerminalEmploymentStatus(null), false, "null status is not terminal");
  assert.equal(isTerminalEmploymentStatus(undefined), false, "undefined status is not terminal");
  assert.equal(isTerminalEmploymentStatus(""), false, "empty status is not terminal");

  // Read-time lifecycle gate decision (pure):
  // active / on_leave -> allowed.
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "active" }).allowed,
    true,
    "active employee + active app user is allowed",
  );
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "on_leave" }).allowed,
    true,
    "on_leave employee is allowed",
  );
  // null / empty status (incl. employee row not found, surfaced as null) -> allowed.
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: null }).allowed,
    true,
    "missing/unset status remains allowed (unlinked/system account)",
  );
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "" }).allowed,
    true,
    "empty status remains allowed",
  );
  // terminal status -> denied with an audited reason.
  const terminalGate = evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "resigned" });
  assert.equal(terminalGate.allowed, false, "resigned employee is denied");
  assert.equal(
    terminalGate.allowed === false && terminalGate.reason,
    "employee_terminal",
    "terminal denial carries the employee_terminal reason",
  );
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "terminated" }).allowed,
    false,
    "terminated employee is denied",
  );
  // unexpected lookup error -> DENIED (fail closed, not silently allowed).
  const errorGate = evaluateEmployeeLifecycleGate({ lookupFailed: true, employmentStatus: "active" });
  assert.equal(errorGate.allowed, false, "unexpected employee lookup error is denied, not allowed");
  assert.equal(
    errorGate.allowed === false && errorGate.reason,
    "employee_lookup_failed",
    "lookup-failure denial carries the employee_lookup_failed reason",
  );

  // Wiring: server session resolution must enforce lifecycle at read time without
  // relying on app_auth_users.is_active alone, and must keep the existing gates.
  const serverSource = readFileSync(
    new URL("../src/lib/auth/server.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    serverSource,
    /resolveEmployeeLifecycleGate\(supabase, row\.hr_id\)/,
    "session resolution must evaluate the linked employee lifecycle gate",
  );
  assert.match(
    serverSource,
    /if \(!lifecycleGate\.allowed\)/,
    "session must be rejected when the lifecycle gate denies",
  );
  // Fail-closed on lookup error: the error branch must deny, not allow.
  assert.match(
    serverSource,
    /if \(error\) return \{ allowed: false, reason: "employee_lookup_failed" \}/,
    "an unexpected employee lookup error must fail closed (deny)",
  );
  assert.match(
    serverSource,
    /employment_status/,
    "session resolution must read employees.employment_status",
  );
  // Existing gates remain unchanged: inactive app user and session-version checks.
  assert.match(serverSource, /if \(!row\.is_active\)/, "is_active gate must remain");
  assert.match(
    serverSource,
    /reason: "session_version_mismatch"/,
    "session_version invalidation must remain unchanged",
  );
}
