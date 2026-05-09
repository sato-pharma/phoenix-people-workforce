import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getRequestIp, writeAuthAudit } from "@/lib/auth/audit";
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
  
  
  cookieStore.delete(phoenixSupabaseAccessTokenCookieName);
  cookieStore.delete(phoenixSupabaseRefreshTokenCookieName);
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
