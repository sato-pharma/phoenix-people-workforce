import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { phoenixNativeClientUserAgentMarker } from "@/lib/auth/native-session";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { phoenixSessionCookieName, verifySessionToken } from "@/lib/auth/session";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hand the native app the bearer for a session it just established through the REAL web login.
 *
 * WHY THIS EXISTS. The app used to sign in by POSTing credentials to `/api/auth/login` and reading
 * the bearer out of the JSON body. The owner's 2026-09-29 decision made the app a shell over the web
 * portal, login included: a rep now signs in on the production `/login` page inside the app's
 * WebView — the same page, the same biometrics, the same design, forever, because it IS the page.
 * That login sets the `phoenix_session` COOKIE in the WebView's jar. But the native half — Phoenix
 * CRM, its offline outbox, push — talks to the API with a `Authorization: Bearer` header, not a
 * cookie (`native-session.ts` explains why). So the WebView has a live session the native half
 * cannot use. This endpoint is the one bridge across that gap: it reads the cookie session and hands
 * back the SAME signed token as a bearer, for the app to keep in the OS keystore.
 *
 * 🔴 IT GRANTS NOTHING THE COOKIE DOES NOT. It returns the token already in the cookie — same `sid`,
 * same `ver`, the SAME expiry — never a fresh or longer-lived one. It mints nothing. A caller who
 * has the cookie can already act as the user for the rest of the session's life; this only lets the
 * native app that owns this WebView read that same authority into the keystore, which
 * `native-session.ts` already judged the right home for it.
 *
 * 🔴 THE ONE INCREMENTAL RISK, STATED PLAINLY FOR THE RISK REVIEW. A bearer, unlike the cookie, works
 * off-origin — so page script that stole one could use it away from this site, where the cookie
 * (same-site) could not follow. The three guards below are why that is an acceptable trade and not a
 * new hole, but they do not make it zero, and they are the whole security surface of this route:
 *   1. `assertSameOriginMutation` — a cross-site page cannot trigger it at all.
 *   2. The WebView user-agent marker — a normal desktop/mobile browser, and any other app's WebView,
 *      is refused. Only Phoenix's own shell carries it. (It does NOT stop script running INSIDE the
 *      shell — nothing can, since it shares the page's context — so this narrows the caller, it does
 *      not authenticate one.)
 *   3. A live cookie session (`source === "session"`) — a guest or a dev-header context is refused.
 * If the review is not satisfied that (1)+(2)+(3) hold the line, the fallback is unchanged: keep the
 * old native `/api/auth/login` sign-in and restyle the native screen instead. This route is the only
 * thing that would have to come out.
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;

  // Only Phoenix's own native shell — a normal browser never carries this marker. The WebView sets
  // it as `applicationNameForUserAgent`, so it rides EVERY request from that WebView, top-level and
  // fetch alike (a header on the initial load would not reach the page's own fetch).
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!userAgent.includes(phoenixNativeClientUserAgentMarker)) {
    return NextResponse.json({ error: "not_the_app" }, { status: 403 });
  }

  // The session must be a real, live cookie login — not a guest, not a dev-auth header context. This
  // runs the full session validation (revoked / idle / absolute-expiry / lifecycle), so a cookie
  // that has stopped being valid mints nothing.
  const access = await resolveAccessContext(request);
  if (access.source !== "session" || !access.loginId) {
    return NextResponse.json({ error: "no_session" }, { status: 401 });
  }
  // The same minimal gate the portal shell asserts before it renders anything — a caller who cannot
  // open the portal is not handed a bearer into it. Every portal role holds it; a role that does not
  // is refused here rather than at the first native request.
  try {
    await assertPermission(access, "employee_profile", "read");
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw error;
  }

  // The bearer IS the cookie's value — read it and re-verify rather than re-issuing, so this can
  // never hand back a different or longer-lived token than the one the browser already holds.
  const token = (await cookies()).get(phoenixSessionCookieName)?.value ?? null;
  const payload = verifySessionToken(token);
  if (!token || !payload) {
    return NextResponse.json({ error: "no_session" }, { status: 401 });
  }

  const response = NextResponse.json({
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    landingPath: resolveLandingPathForRole(payload.role),
    sessionToken: token,
    user: { hrId: payload.hrId, loginId: payload.loginId, role: payload.role },
  });
  // A bearer in a body, for one caller — never cached anywhere.
  response.headers.set("cache-control", "no-store, private");
  return response;
}
