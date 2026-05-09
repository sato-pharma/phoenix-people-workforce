import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getRequestIp, getRequestUserAgent, writeAuthAudit } from "@/lib/auth/audit";
import { phoenixSessionCookieName, verifySessionToken } from "@/lib/auth/session";
import {
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
} from "@/lib/auth/supabase-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(phoenixSessionCookieName)?.value ?? null;
  const session = verifySessionToken(sessionToken);
  const ip = getRequestIp(request);
  const userAgent = getRequestUserAgent(request);
  
  cookieStore.delete(phoenixSupabaseAccessTokenCookieName);
  cookieStore.delete(phoenixSupabaseRefreshTokenCookieName);
  cookieStore.delete(phoenixSessionCookieName);

  if (session) {
    await writeAuthAudit({
      actorHrId: session.hrId,
      actorLoginId: session.loginId,
      actorRole: session.role,
      entityId: session.loginId,
      newValues: {
        ip,
        sessionId: session.sid,
        sessionVersion: session.ver,
        userAgent,
      },
      requestIp: ip,
      summary: "Logout succeeded",
      userAgent,
    }).catch(() => undefined);
  }
  
  return NextResponse.json({ success: true });
}
