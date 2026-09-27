import { NextResponse } from "next/server";

import { bearerTokenFromRequest } from "@/lib/auth/native-session";
import {
  issueNativeWebHandoffTicket,
  nativeWebHandoffCookie,
  redeemNativeWebHandoffTicket,
  safeNativeWebHandoffNext,
} from "@/lib/auth/native-web-handoff";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { phoenixSessionCookieName } from "@/lib/auth/session";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Opening a production portal module from the native app, already signed in.
 *
 * Two halves of one hand-off, and which half is which matters (see `native-web-handoff.ts`):
 *
 *   POST — the APP asks, with its bearer token. Answers a one-trip URL. Sets NO cookie, because a
 *          cookie on this response would be replayed by React Native's own networking on every later
 *          request and refused by the CSRF guard as `csrf_blocked`.
 *   GET  — the BROWSER redeems, in its own cookie jar. Sets the session cookie and redirects to the
 *          module. The app never calls this half.
 *
 * The module that opens is the production page itself — same modules, same design, same numbers as
 * the browser, because it IS the browser.
 */

/** Mint. Called by the app with `Authorization: Bearer <its session token>`. */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // The same gate the portal shell asserts before it will render anything at all. A caller who
    // cannot open the portal cannot be handed a ticket into it.
    await assertPermission(access, "employee_profile", "read");

    // The cookie path is deliberately not accepted here: a browser already HAS a session, and
    // minting one of these for a page's JavaScript would hand it a redeemable credential the
    // HttpOnly cookie exists to keep out of reach.
    const bearer = bearerTokenFromRequest(request);
    const ticket = bearer ? issueNativeWebHandoffTicket(bearer) : null;

    if (!ticket) {
      return NextResponse.json(
        {
          error: "bearer_session_required",
          message: "Open this from the Phoenix app while signed in.",
        },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const next = safeNativeWebHandoffNext(searchParams.get("next"));
    const url = new URL("/api/auth/web-session", trustedOriginForRedirect(request));
    url.searchParams.set("ticket", ticket);
    url.searchParams.set("next", next);

    return NextResponse.json({ data: { next, url: url.toString() }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    logPortalFailure({ route: "/api/auth/web-session", module: "native-web-handoff" }, error);
    const message = clientSafeErrorMessage(error, "Unable to open that module.");
    return NextResponse.json({ error: "web_session_failed", message }, { status: 500 });
  }
}

/** Redeem. Called by the browser tab the app opened, and only by it. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = trustedOriginForRedirect(request);
  const next = safeNativeWebHandoffNext(searchParams.get("next"));

  const claims = redeemNativeWebHandoffTicket(searchParams.get("ticket"));

  if (!claims) {
    // Expired or tampered with: send the person to the ordinary login page rather than an API error
    // page. `next` is already narrowed to a portal path, so it is safe to carry through.
    const login = new URL("/login", origin);
    login.searchParams.set("next", next);
    return NextResponse.redirect(login, 303);
  }

  const { maxAgeSeconds, token } = nativeWebHandoffCookie(claims);

  // 303, and the ticket is gone from the address the moment this lands — the browser follows to the
  // module's own URL, so the ticket never becomes the page's address or its referrer.
  const response = NextResponse.redirect(new URL(next, origin), 303);
  response.cookies.set({
    httpOnly: true,
    maxAge: maxAgeSeconds,
    name: phoenixSessionCookieName,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    value: token,
  });
  // Never cached, anywhere: the response body is a redirect carrying a Set-Cookie for one person.
  response.headers.set("cache-control", "no-store, private");

  return response;
}
