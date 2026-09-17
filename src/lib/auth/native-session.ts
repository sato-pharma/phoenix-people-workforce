/**
 * Carrying a Phoenix session on a native client.
 *
 * The web app carries its session in the `phoenix_session` cookie, set HttpOnly at login. A native
 * Android/iOS client has no cookie jar we control and no HttpOnly guarantee to lean on, so it
 * carries the SAME signed token in an `Authorization: Bearer` header instead.
 *
 * "The same token" is the whole point, and the reason this file is ten lines of parsing rather than
 * a second authentication scheme. The bearer path hands its token to `resolveSessionAccessContext`
 * — the identical function the cookie path uses — so it still gets:
 *
 *   - the HMAC signature check and expiry check (`verifySessionToken`)
 *   - the `app_sessions` row lookup: revoked, idle-expired, absolutely-expired, session_version
 *   - the employee-lifecycle gate (a terminated employee's token stops working)
 *   - the same rejection audit rows
 *
 * A bearer token therefore grants nothing a cookie does not, and expires on exactly the same clock.
 * There is no "native" role, no longer lifetime, and no bypass.
 *
 * WHAT IS GENUINELY DIFFERENT, and the reason the token is only ever returned in a response body to
 * a client that asks for it by name: the cookie is HttpOnly, so page JavaScript cannot read it. A
 * token in a JSON body can be read by whatever made the request. That is an acceptable trade for a
 * native app — the OS keystore (expo-secure-store) is a better home for it than a cookie jar — but
 * it would be a real regression to hand one to a browser. Hence `isNativeClientRequest`: the login
 * route returns `sessionToken` ONLY when the caller declares itself native, so no existing browser
 * code path can start leaking one by accident.
 *
 * This is not a defence against cross-site scripting — script running on the page could set the
 * header and ask. It does not need to be: script running on the page can already act as the user
 * through the cookie for the rest of the session's life. The header is a guard against ACCIDENT,
 * which is the failure that actually happens, and the token's lifetime is unchanged either way.
 * The hardening that would matter here is a device-bound refresh token, which is a later phase and
 * deliberately not faked with a flag now.
 */

/**
 * Header a native client sets to identify itself. Value is informational — the login route only
 * checks that the header is present and non-empty, so adding a platform later needs no change here.
 */
export const phoenixNativeClientHeaderName = "x-phoenix-client";

/**
 * True when the caller declares itself a native app. Used by the login route to decide whether the
 * JSON response carries `sessionToken`; never used to grant permission.
 */
export function isNativeClientRequest(headers: Headers): boolean {
  const declared = headers.get(phoenixNativeClientHeaderName);
  return typeof declared === "string" && declared.trim().length > 0;
}

/**
 * The bearer token from an `Authorization` header, or null.
 *
 * Deliberately strict: the scheme must be exactly `Bearer` (case-insensitive, as RFC 6750 requires)
 * followed by a non-empty credential. A malformed header returns null and the caller falls through
 * to the cookie path and then to anonymous — it never throws, because an unauthenticated request is
 * a normal thing for this function to be handed.
 */
export function bearerTokenFromAuthorizationHeader(
  authorizationHeader: string | null | undefined,
): string | null {
  if (!authorizationHeader) return null;

  const trimmed = authorizationHeader.trim();
  const separatorIndex = trimmed.indexOf(" ");
  if (separatorIndex <= 0) return null;

  const scheme = trimmed.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== "bearer") return null;

  const credential = trimmed.slice(separatorIndex + 1).trim();
  return credential.length > 0 ? credential : null;
}

/** Convenience wrapper for a `Request`. */
export function bearerTokenFromRequest(request: Request): string | null {
  return bearerTokenFromAuthorizationHeader(request.headers.get("authorization"));
}
