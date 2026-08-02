import assert from "node:assert/strict";
import {
  isUnauthenticatedAccess,
  unauthenticatedSessionResponse,
} from "../src/lib/auth/api-session-response.ts";

const GUEST = { source: "guest" } as const;
const SIGNED_IN = { source: "session" } as const;
const SYSTEM = { source: "system" } as const;
const DEV_HEADER = { source: "dev-header" } as const;

export async function runApiSessionExpiredResponseTests() {
  // --- an expired/absent session is reported as an expired session, not as a permissions problem ---

  const guestResponse = unauthenticatedSessionResponse(GUEST);
  assert.ok(guestResponse, "a request with no usable session must be answered, not waved through");
  assert.equal(
    guestResponse.status,
    401,
    "no session is 401 (who are you), never 403 (I know who you are and you may not) — the 403 is what sent a reviewer hunting through role permissions for an expired cookie",
  );

  const body = await guestResponse.json();
  assert.equal(body.error, "session_expired", "the client keys off a stable error code, not prose");
  assert.match(
    body.message,
    /sign in again/i,
    "the message must name the one action that fixes it, instead of describing a resource the caller was never denied",
  );
  assert.doesNotMatch(
    body.message,
    /permission|access to/i,
    "the message must not read as a permissions failure — that is the exact misdiagnosis being fixed",
  );

  // --- THE SAFETY PROPERTY: this may only reclassify a denial, never widen access ---

  assert.equal(
    unauthenticatedSessionResponse(SIGNED_IN),
    null,
    "a signed-in caller falls through to the route's own permission check, so someone who lacks a permission still gets their 403 — this guard must never answer for them",
  );
  assert.equal(
    unauthenticatedSessionResponse(SYSTEM),
    null,
    "a system/service context is never intercepted",
  );
  assert.equal(
    unauthenticatedSessionResponse(DEV_HEADER),
    null,
    "a dev-header context is a real resolved identity and must reach the permission check",
  );

  // The guard returns a DENIAL, never data — so even the case it does answer cannot leak anything.
  assert.ok(
    guestResponse.status >= 400,
    "the only response this guard ever produces is a refusal",
  );

  // --- the predicate agrees with the response helper, so callers can branch either way ---

  assert.equal(isUnauthenticatedAccess(GUEST), true, "guest is unauthenticated");
  assert.equal(isUnauthenticatedAccess(SIGNED_IN), false, "a session is authenticated");
  assert.equal(isUnauthenticatedAccess(SYSTEM), false, "system is authenticated");
  assert.equal(isUnauthenticatedAccess(DEV_HEADER), false, "dev-header is authenticated");

  for (const context of [GUEST, SIGNED_IN, SYSTEM, DEV_HEADER]) {
    assert.equal(
      isUnauthenticatedAccess(context),
      unauthenticatedSessionResponse(context) !== null,
      `predicate and response must agree for source=${context.source}, or a route could refuse on one signal while another route allows on the other`,
    );
  }
}
