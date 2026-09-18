import assert from "node:assert/strict";

import { phoenixNativeClientHeaderName } from "../src/lib/auth/native-session.ts";
import { phoenixSessionCookieName } from "../src/lib/auth/session-token.ts";
import { assertSameOriginMutation } from "../src/lib/security/api-csrf.ts";
import { isNativeClientMutationRequest } from "../src/lib/security/csrf.ts";

/**
 * The native app is allowed to write; nothing else gained anything.
 *
 * WHY THIS EXISTS. Every Phoenix mutation is guarded by an Origin/Referer check, and React Native's
 * `fetch` sends neither header — so before the exemption this pins, the Android app could read but
 * never write. Not only the camera upload: `POST /api/auth/login` was refused with `csrf_blocked` in
 * production, so the app shipped in phase one could not sign in against the live server at all.
 *
 * WHAT MUST STAY TRUE, and what this file is really for. The exemption rests on TWO conditions, and
 * the second one is the load-bearing one:
 *
 *   1. the request declares itself native with `x-phoenix-client`, a header no cross-site page can
 *      attach (it is not CORS-safelisted, and Phoenix answers no preflight), AND
 *   2. the request carries NO session cookie.
 *
 * Drop (2) and the exemption stops being a native-app rule and becomes "any request that sets a
 * header skips CSRF" — which is precisely the hole CSRF protection exists to close, because a cookie
 * request is a browser request whatever else it carries. `headerAloneIsNotEnough` below is the test
 * that fails when that happens. 🔴 If it goes red, the exemption widened: fix the exemption, never
 * this test.
 */

function headersWith(values: Record<string, string>): Headers {
  return new Headers(values);
}

const NATIVE = { [phoenixNativeClientHeaderName]: "phoenix-android" };

function nativeExemptionHolds() {
  assert.equal(
    isNativeClientMutationRequest(headersWith(NATIVE)),
    true,
    "the app declares itself native and carries no cookie — this is the case the exemption exists for",
  );

  assert.equal(
    isNativeClientMutationRequest(headersWith({ ...NATIVE, cookie: "theme=dark; locale=en" })),
    true,
    "an unrelated cookie is not a session; only the Phoenix session cookie means a browser is authenticating",
  );
}

function headerAloneIsNotEnough() {
  assert.equal(
    isNativeClientMutationRequest(
      headersWith({ ...NATIVE, cookie: `${phoenixSessionCookieName}=abc.def.ghi` }),
    ),
    false,
    "🔴 a session cookie present means the cookie authenticates, so full CSRF protection must apply however the request labels itself",
  );

  assert.equal(
    isNativeClientMutationRequest(
      headersWith({ ...NATIVE, cookie: `other=1; ${phoenixSessionCookieName}=abc; last=2` }),
    ),
    false,
    "the session cookie must be found among others, not only when it is the whole header",
  );
}

function everythingElseIsUnchanged() {
  assert.equal(
    isNativeClientMutationRequest(headersWith({})),
    false,
    "a bare request is not native and must still face the origin check",
  );

  assert.equal(
    isNativeClientMutationRequest(headersWith({ [phoenixNativeClientHeaderName]: "   " })),
    false,
    "a whitespace-only header is not a declaration — matches isNativeClientRequest, which the login route uses",
  );

  assert.equal(
    isNativeClientMutationRequest(headersWith({ origin: "https://evil.example.com" })),
    false,
    "an attacker's origin gains nothing here; this function only ever answers about the native header",
  );
}

/**
 * The route-level guard has to agree with the proxy. The proxy only covers `isSecurityProxyPath`,
 * so a route outside that set is refused at the route and nowhere else — an exemption honoured at
 * one site and not the other would let the app write to some routes and not others.
 */
function bothRefusalSitesAgree() {
  const nativePost = new Request("https://phoenix-hr.satopharma.com/api/employee-portal/profile-photo", {
    headers: { host: "phoenix-hr.satopharma.com", ...NATIVE },
    method: "POST",
  });
  assert.equal(
    assertSameOriginMutation(nativePost),
    null,
    "assertSameOriginMutation must let the native app through, or the app can write only to proxy-covered routes",
  );

  const barePost = new Request("https://phoenix-hr.satopharma.com/api/employee-portal/profile-photo", {
    headers: { host: "phoenix-hr.satopharma.com" },
    method: "POST",
  });
  const refusal = assertSameOriginMutation(barePost);
  assert.notEqual(refusal, null, "a request with no origin and no native header is still refused");
  assert.equal(refusal?.status, 403, "and refused with 403, exactly as before this exemption existed");

  const cookiePost = new Request("https://phoenix-hr.satopharma.com/api/employee-portal/profile-photo", {
    headers: {
      cookie: `${phoenixSessionCookieName}=abc.def.ghi`,
      host: "phoenix-hr.satopharma.com",
      ...NATIVE,
    },
    method: "POST",
  });
  assert.equal(
    assertSameOriginMutation(cookiePost)?.status,
    403,
    "🔴 a cookie-authenticated request is refused even carrying the native header — the exemption must never reach a browser session",
  );
}

export function runNativeClientCsrfExemptionTests() {
  nativeExemptionHolds();
  headerAloneIsNotEnough();
  everythingElseIsUnchanged();
  bothRefusalSitesAgree();
}
