import { NextResponse } from "next/server";

import {
  createSessionToken,
  getCookieValue,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
  verifySessionToken,
} from "@/lib/auth/session";
import {
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
} from "@/lib/auth/supabase-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = verifySessionToken(
    getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName),
  );

  if (!session) {
    const response = NextResponse.json(
      { error: "session_expired", message: "Session expired." },
      { status: 401 },
    );
    response.cookies.set({
      httpOnly: true,
      maxAge: 0,
      name: phoenixSessionCookieName,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      value: "",
    });
    response.cookies.set({
      httpOnly: true,
      maxAge: 0,
      name: phoenixSupabaseAccessTokenCookieName,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      value: "",
    });
    response.cookies.set({
      httpOnly: true,
      maxAge: 0,
      name: phoenixSupabaseRefreshTokenCookieName,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      value: "",
    });
    return response;
  }

  const now = Math.floor(Date.now() / 1000);
  const idleTimeoutSeconds = sessionIdleTimeoutSecondsForRole(session.role);
  const refreshedExpiresAt = now + idleTimeoutSeconds;
  const refreshed = createSessionToken({
    hrId: session.hrId,
    loginId: session.loginId,
    maxAgeSeconds: idleTimeoutSeconds,
    role: session.role,
    sessionId: session.sid,
    sessionVersion: session.ver,
  });

  const response = NextResponse.json({
    expiresAt: refreshedExpiresAt,
    idleExpiresAt: refreshedExpiresAt,
    ok: true,
  });
  response.cookies.set({
    httpOnly: true,
    name: phoenixSessionCookieName,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    value: refreshed,
  });

  return response;
}
