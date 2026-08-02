import assert from "node:assert/strict";

process.env.PHOENIX_AUTH_SECRET ??= "root-redirect-test-secret";

const { createSessionToken } = await import("../src/lib/auth/session-token.ts");
const { resolveRootRedirectPath } = await import("../src/lib/auth/root-landing.ts");

function signedTokenForRole(role: Parameters<typeof createSessionToken>[0]["role"]) {
  return createSessionToken({
    hrId: "HR-0001",
    loginId: "root.redirect.test",
    maxAgeSeconds: 3600,
    role,
    sessionId: "root-redirect-test-session",
    sessionVersion: 1,
  });
}

export function runRootRedirectHttp307Tests() {
  // "/" must resolve to a destination from the cookie ALONE. If this ever needs a database
  // round-trip again it cannot be answered in proxy.ts, the shell flushes first, and the
  // redirect silently degrades to the JS-only RSC digest that stranded mobile users on
  // "Loading Phoenix Workforce..." forever.
  assert.equal(
    resolveRootRedirectPath(undefined),
    "/login",
    "no cookie is the signed-out case — it must still produce a real destination, never a render",
  );
  assert.equal(resolveRootRedirectPath(null), "/login", "a null cookie value resolves like no cookie");
  assert.equal(resolveRootRedirectPath(""), "/login", "an empty cookie value resolves like no cookie");

  // A forged/edited cookie must not pick the destination — verifySessionToken rejects it and the
  // user is sent to sign in, exactly as an anonymous visitor is.
  assert.equal(
    resolveRootRedirectPath("not-a-real-token"),
    "/login",
    "an unsigned string is rejected, so a tampered cookie can never choose a landing path",
  );
  assert.equal(
    resolveRootRedirectPath(`${signedTokenForRole("CEO")}x`),
    "/login",
    "a signature that does not verify falls back to /login rather than trusting the payload's role",
  );

  // A valid session goes straight to its role's landing path, so a signed-in user never pays for
  // an extra /login hop on a slow connection.
  assert.equal(
    resolveRootRedirectPath(signedTokenForRole("CEO")),
    "/admin/ceo-command-center",
    "CEO lands on the CEO command center, matching resolveLandingPathForRole",
  );
  assert.equal(
    resolveRootRedirectPath(signedTokenForRole("Medical Rep")),
    "/employee-portals",
    "portal roles land in the employee portal, not the admin shell",
  );
  assert.equal(
    resolveRootRedirectPath(signedTokenForRole("Super Admin")),
    "/admin",
    "admin-shell roles land on /admin",
  );
  assert.equal(
    resolveRootRedirectPath(signedTokenForRole("Finance Manager")),
    "/admin/outstation/expense-command",
    "a role with a bespoke landing path keeps it — the proxy must not flatten everyone to /admin",
  );
}
