import assert from "node:assert/strict";

import {
  bearerTokenFromAuthorizationHeader,
  isNativeClientRequest,
  phoenixNativeClientHeaderName,
} from "../src/lib/auth/native-session.ts";

/**
 * The native app carries its session in an `Authorization: Bearer` header instead of a cookie, and
 * `resolveAccessContextInner` hands whatever this parser returns straight to the same session
 * validator the cookie path uses. So the parser is the boundary: a token it invents out of a
 * malformed header is a token the validator then has to reject, and a scheme it accepts loosely is
 * a wider surface than the cookie path has.
 *
 * These pin the two things that would not be obvious from reading the function later — that a
 * non-Bearer scheme yields null rather than the credential after the space, and that the native
 * client marker is presence-based rather than an allow-list of platform names.
 */
export function runNativeSessionBearerTests() {
  assert.equal(
    bearerTokenFromAuthorizationHeader("Bearer abc.def"),
    "abc.def",
    "the ordinary case: everything after the scheme is the token, including the token's own dot separator",
  );
  assert.equal(
    bearerTokenFromAuthorizationHeader("bearer abc.def"),
    "abc.def",
    "RFC 6750 makes the scheme case-insensitive, and some HTTP clients lower-case it in transit",
  );
  assert.equal(
    bearerTokenFromAuthorizationHeader("  Bearer   abc.def  "),
    "abc.def",
    "surrounding and inner whitespace is trimmed, so a padded header still authenticates rather than failing for a reason nobody can see",
  );

  assert.equal(
    bearerTokenFromAuthorizationHeader("Basic YWxhZGRpbjpvcGVuc2VzYW1l"),
    null,
    "a non-Bearer scheme yields null, never the credential after the space — otherwise Basic auth material would be handed to the session validator as if it were a Phoenix token",
  );
  assert.equal(
    bearerTokenFromAuthorizationHeader("Bearer"),
    null,
    "a scheme with no credential is not a session; returning '' here would send an empty token into verifySessionToken",
  );
  assert.equal(
    bearerTokenFromAuthorizationHeader("Bearer   "),
    null,
    "whitespace is not a credential",
  );
  assert.equal(
    bearerTokenFromAuthorizationHeader("abc.def"),
    null,
    "a bare token with no scheme is rejected: the header format is the only signal that the caller meant this as a bearer credential",
  );
  assert.equal(bearerTokenFromAuthorizationHeader(null), null, "no header is not an error — an unauthenticated request is normal and must fall through to anonymous");
  assert.equal(bearerTokenFromAuthorizationHeader(undefined), null, "same for undefined");
  assert.equal(bearerTokenFromAuthorizationHeader(""), null, "same for an empty header");

  // The native-client marker decides only whether the login route RETURNS a session token in its
  // JSON body. It grants nothing, so it is deliberately presence-based: adding iOS later must not
  // require editing an allow-list of platform strings here.
  assert.equal(
    isNativeClientRequest(new Headers({ [phoenixNativeClientHeaderName]: "phoenix-android" })),
    true,
    "a declared native client is recognised",
  );
  assert.equal(
    isNativeClientRequest(new Headers({ [phoenixNativeClientHeaderName]: "phoenix-ios" })),
    true,
    "presence, not a platform allow-list — a second platform must not need a code change here",
  );
  assert.equal(
    isNativeClientRequest(new Headers({ [phoenixNativeClientHeaderName]: "   " })),
    false,
    "a blank value is not a declaration, so a proxy that adds the header empty cannot make the login route start returning tokens",
  );
  assert.equal(
    isNativeClientRequest(new Headers()),
    false,
    "a browser sends no such header and must never receive a session token in the response body — the cookie is HttpOnly precisely so page script cannot read it",
  );
}
