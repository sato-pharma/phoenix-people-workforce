import type { NextRequest } from "next/server";

import { phoenixNativeClientHeaderName } from "@/lib/auth/native-session";
import { getCookieValue, phoenixSessionCookieName } from "@/lib/auth/session-token";
import {
  isAllowedPhoenixOrigin,
  normalizeOrigin,
  originFromHostParts,
} from "@/lib/security/origins";

const csrfProtectedMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

function expectedOrigins(request: NextRequest) {
  const origins = new Set<string>();
  const requestUrlOrigin = normalizeOrigin(request.url);
  const nextUrlOrigin = normalizeOrigin(request.nextUrl.origin);
  const forwardedOrigin = originFromHostParts(
    request.headers.get("x-forwarded-host"),
    request.headers.get("x-forwarded-proto"),
  );
  const hostOrigin = originFromHostParts(
    request.headers.get("host"),
    request.nextUrl.protocol.replace(/:$/, ""),
  );

  for (const origin of [requestUrlOrigin, nextUrlOrigin, forwardedOrigin, hostOrigin]) {
    if (origin && isAllowedPhoenixOrigin(origin)) {
      origins.add(origin);
    }
  }

  return origins;
}

export function requiresCsrfProtection(request: NextRequest) {
  return csrfProtectedMethods.has(request.method.toUpperCase());
}

export function isSameOriginMutationRequest(request: NextRequest) {
  const allowedOrigins = expectedOrigins(request);
  const originHeader = normalizeOrigin(request.headers.get("origin"));

  if (originHeader) {
    return allowedOrigins.has(originHeader);
  }

  const refererOrigin = normalizeOrigin(request.headers.get("referer"));
  if (refererOrigin) {
    return allowedOrigins.has(refererOrigin);
  }

  return false;
}

/**
 * True when a mutation comes from the native app and therefore cannot be a cross-site forgery.
 *
 * WHY AN EXEMPTION EXISTS AT ALL. The origin check above answers "did a browser send this from a
 * Phoenix page", and a native app is not a browser: React Native's `fetch` sends no `Origin` and no
 * `Referer`, so `isSameOriginMutationRequest` returns false for every request the app makes. Before
 * this function that meant the app could read but never write — and not only the camera upload:
 * `POST /api/auth/login` was refused with `csrf_blocked` in production, so the app shipped in phase
 * one could not sign in against the live server at all. Measured against production 2026-09-18, and
 * approved by the owner the same day.
 *
 * WHY IT IS SAFE, which is the only part that matters. CSRF is an attack on AMBIENT authority: the
 * browser attaches the session cookie to a cross-site request by itself, so a page the employee
 * never trusted can act as them. Two independent things make that impossible here, and BOTH are
 * required:
 *
 *   1. `x-phoenix-client` is not a CORS-safelisted header. An HTML form cannot set one at all, and
 *      a cross-site `fetch` that sets one forces a preflight. Phoenix answers that preflight with
 *      NO `Access-Control-Allow-Origin` and NO `Access-Control-Allow-Headers` (verified against
 *      https://phoenix-hr.satopharma.com, 2026-09-18), so the browser refuses to send the real
 *      request. Requiring a custom header is the classic CSRF defence for exactly this reason.
 *   2. The request must carry NO session cookie. This is the belt to that braces, and it is what
 *      keeps the exemption from widening by accident: a request holding a cookie is a browser
 *      request whatever else it carries, so it keeps full CSRF protection. It also matches
 *      `resolveAccessContext`, which prefers the cookie over the bearer token when both are present
 *      and says so in its own comment — without this clause the guard would be reasoning about a
 *      different credential from the one the route actually authenticates with.
 *
 * WHAT IT DOES NOT DO. It grants no permission and identifies nobody. A request that passes here
 * still authenticates — by bearer token, through the same `resolveSessionAccessContext` the cookie
 * path uses — and still clears `assertPermission`. Skipping the origin check is not skipping the
 * auth check, and this is never a reason to weaken the second one.
 *
 * The same shape already exists in this repo for machine callers: `access-registry.ts` records
 * `/api/integrations/ftp-videos` as bearer-guarded with the note "No session, so CSRF-exempt."
 *
 * 🔴 Pinned by `tests/native-client-csrf-exemption.test.ts`. If that test goes red because the
 * exemption widened — a cookie request passing, or the header alone being enough — the exemption is
 * wrong, not the test.
 */
export function isNativeClientMutationRequest(headers: Pick<Headers, "get">): boolean {
  const declared = headers.get(phoenixNativeClientHeaderName);
  if (typeof declared !== "string" || declared.trim().length === 0) return false;

  // A session cookie present means the cookie decides, so the ambient-authority risk is back and
  // the exemption must not apply — clause 2 above.
  return !getCookieValue(headers.get("cookie"), phoenixSessionCookieName);
}
