import assert from "node:assert/strict";

import {
  createSessionToken,
  sessionIdleTimeoutSecondsForRole,
  verifySessionToken,
} from "../src/lib/auth/session-token.ts";

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
}
