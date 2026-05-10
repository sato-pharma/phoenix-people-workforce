import { NextResponse } from "next/server";

import {
  createSessionToken,
  getCookieValue,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
  verifySessionToken,
} from "@/lib/auth/session";

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
    return response;
  }

  const now = Math.floor(Date.now() / 1000);
  const remainingSeconds = Math.max(0, session.exp - now);
  const idleTimeoutSeconds = sessionIdleTimeoutSecondsForRole(session.role);
  const refreshedMaxAgeSeconds = Math.min(remainingSeconds, idleTimeoutSeconds);
  const refreshed = createSessionToken({
    hrId: session.hrId,
    loginId: session.loginId,
    maxAgeSeconds: refreshedMaxAgeSeconds,
    role: session.role,
    sessionId: session.sid,
    sessionVersion: session.ver,
  });

  const response = NextResponse.json({
    expiresAt: session.exp,
    idleExpiresAt: Math.min(
      session.exp,
      now + idleTimeoutSeconds,
    ),
    ok: true,
  });
  response.cookies.set({
    httpOnly: true,
    maxAge: refreshedMaxAgeSeconds,
    name: phoenixSessionCookieName,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    value: refreshed,
  });

  return response;
}
