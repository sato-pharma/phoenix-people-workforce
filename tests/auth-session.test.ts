import assert from "node:assert/strict";

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
}
