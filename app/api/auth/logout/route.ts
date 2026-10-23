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
  // guards only the database work below (the session revoke and the audit row).
  cookieStore.delete(phoenixSupabaseAccessTokenCookieName);
  cookieStore.delete(phoenixSupabaseRefreshTokenCookieName);
  cookieStore.delete(phoenixDevPreviewCookieName);
  cookieStore.delete(phoenixSeatViewCookieName);
  cookieStore.delete(phoenixSessionCookieName);

  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: session?.loginId ?? null, request, token: sessionToken }),
      limit: 30,
      scope: "auth:logout",
      windowMs: 60 * 1000,
    });
  } catch (error) {
    // Signed out in this browser all the same; only the server-side revoke was skipped. A limiter that
    // could not be asked is logged, never a 500 — a failed response may not carry the cleared cookies.
    if (!isApiRateLimitError(error)) {
      console.error("[auth/logout] rate limit check failed; signed out without the revoke", error);
    }
    return NextResponse.json({ sessionRevoked: false, success: true });
  }
  
  if (session) {
    await revokeAppSession(session.sid, "logout").catch((error) => {
      console.error("[auth/logout] failed to revoke app session", error);
    });
  }

  if (session) {
    await writeAuthAudit({
      actorLoginId: session.loginId,
      entityId: session.loginId,
      newValues: {
        ip: getRequestIp(request),
        sessionId: session.sid,
        sessionVersion: session.ver,
      },
      summary: "Logout succeeded",
    }).catch(() => undefined);
  }
  
  return NextResponse.json({ success: true });
}
