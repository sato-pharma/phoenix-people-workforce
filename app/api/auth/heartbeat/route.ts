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
import {
  accessContextFromDevPreviewToken,
  createDevPreviewSessionToken,
  devPreviewCookieMaxAgeSeconds,
  phoenixDevPreviewCookieName,
} from "@/lib/auth/dev-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLocalDevelopmentRequest(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export async function POST(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  const session = verifySessionToken(
    getCookieValue(cookieHeader, phoenixSessionCookieName),
  );

  if (!session) {
    const devPreview = isLocalDevelopmentRequest(request)
      ? accessContextFromDevPreviewToken(getCookieValue(cookieHeader, phoenixDevPreviewCookieName))
      : null;

    if (devPreview) {
      const maxAge = devPreviewCookieMaxAgeSeconds();
      const refreshedExpiresAt = Math.floor(Date.now() / 1000) + maxAge;
      const response = NextResponse.json({
        expiresAt: refreshedExpiresAt,
        idleExpiresAt: refreshedExpiresAt,
        ok: true,
      });
      response.cookies.set({
        httpOnly: true,
        maxAge,
        name: phoenixDevPreviewCookieName,
        path: "/",
        sameSite: "lax",
        secure: false,
        value: createDevPreviewSessionToken({
          hrId: devPreview.hrId,
          loginId: devPreview.loginId ?? "dev.preview",
          role: devPreview.role,
        }),
      });
      return response;
    }

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
