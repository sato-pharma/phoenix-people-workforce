import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { revokeAppSession } from "@/lib/auth/app-sessions";
import { getRequestIp, writeAuthAudit } from "@/lib/auth/audit";
import { phoenixDevPreviewCookieName } from "@/lib/auth/dev-preview";
import { phoenixSeatViewCookieName } from "@/lib/auth/seat-view-constants";
import { phoenixSessionCookieName, verifySessionToken } from "@/lib/auth/session";
import {
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
} from "@/lib/auth/supabase-identity";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(phoenixSessionCookieName)?.value ?? null;
  const session = verifySessionToken(sessionToken);

  // THIS BROWSER IS SIGNED OUT FIRST, WHATEVER ELSE HAPPENS (technical audit, 2026-10-23, P7-03). A
  // rate-limited request used to return before the cookies were cleared, while the page still went
  // to /login — on a shared PC the next person found the last one still signed in. The limit now
  // guards only the audit row below; the session revoke runs whatever the limiter says (point 14).
  cookieStore.delete(phoenixSupabaseAccessTokenCookieName);
  cookieStore.delete(phoenixSupabaseRefreshTokenCookieName);
  cookieStore.delete(phoenixDevPreviewCookieName);
  cookieStore.delete(phoenixSeatViewCookieName);
  cookieStore.delete(phoenixSessionCookieName);

  // THE SERVER-SIDE SESSION IS REVOKED NEXT, AND NOTHING CAN SKIP IT (audit point 14, 2026-10-26).
  // It used to sit behind the rate limit, so a limited (or unanswerable) limiter returned early and
  // the session stayed live in app_sessions for its full lifetime: a copied cookie kept working after
  // its owner signed out, and the page was told `success: true` all the same. The revoke needs a
  // validly SIGNED session token, so it cannot be driven by a caller who has none, and revoking an
  // already-revoked session changes nothing. `sessionRevoked` is the real answer.
  let sessionRevoked = false;
  if (session) {
    sessionRevoked = await revokeAppSession(session.sid, "logout").then(
      () => true,
      (error) => {
        console.error("[auth/logout] failed to revoke app session", error);
        return false;
      },
    );
  }

  // The limit now guards only the audit row.
  let auditAllowed = true;
  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: session?.loginId ?? null, request, token: sessionToken }),
      limit: 30,
      scope: "auth:logout",
      windowMs: 60 * 1000,
    });
  } catch (error) {
    // Signed out and revoked all the same; only the audit row is skipped. A limiter that could not be
    // asked is logged, never a 500 — a failed response may not carry the cleared cookies.
    if (!isApiRateLimitError(error)) {
      console.error("[auth/logout] rate limit check failed; signed out without the audit row", error);
    }
    auditAllowed = false;
  }

  if (session && auditAllowed) {
    await writeAuthAudit({
      actorLoginId: session.loginId,
      entityId: session.loginId,
      newValues: {
        ip: getRequestIp(request),
        sessionId: session.sid,
        sessionRevoked,
        sessionVersion: session.ver,
      },
      summary: sessionRevoked ? "Logout succeeded" : "Logout succeeded; the server-side session revoke failed",
    }).catch(() => undefined);
  }

  return NextResponse.json({ sessionRevoked, success: true });
}
