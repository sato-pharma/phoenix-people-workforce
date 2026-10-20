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

  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: session?.loginId ?? null, request, token: sessionToken }),
      limit: 30,
      scope: "auth:logout",
      windowMs: 60 * 1000,
    });
  } catch (error) {
    if (!isApiRateLimitError(error)) throw error;
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many logout requests.",
        retryAfterSeconds: error.retryAfterSeconds,
      },
      { status: 429 },
    );
  }
  
  if (session) {
    await revokeAppSession(session.sid, "logout").catch((error) => {
      console.error("[auth/logout] failed to revoke app session", error);
    });
  }
  
  cookieStore.delete(phoenixSupabaseAccessTokenCookieName);
  cookieStore.delete(phoenixSupabaseRefreshTokenCookieName);
  cookieStore.delete(phoenixDevPreviewCookieName);
  cookieStore.delete(phoenixSeatViewCookieName);
  cookieStore.delete(phoenixSessionCookieName);

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
