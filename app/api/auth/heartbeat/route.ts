import { NextResponse } from "next/server";

import {
  createSessionToken,
  getCookieValue,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
} from "@/lib/auth/session";
import { resolveSessionState } from "@/lib/auth/server";
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
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { isSessionVerificationUnavailable } from "@/lib/auth/session-lifecycle";
import { isSupabaseTimeout } from "@/lib/reports/vacancies";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { classifySupabaseUnreachable } from "@/lib/error-monitor/supabase-unreachable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLocalDevelopmentRequest(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * True when the heartbeat failed because the DATABASE was slow or down, not because the session is
 * bad. A Cloudflare 52x page is the same outage as a timeout, seen from the other side. Both of the
 * heartbeat’s database steps use this one test: until 23 Oct 2026 only the session read did, and the
 * request-counting step before it rethrew its timeout, so every open page crashed with a 500 during
 * each database restart — 106 times for 50 people, mostly 22 Oct 12:00-15:00 Cairo (APP-20D39617).
 */
function isSessionServiceOutage(error: unknown): boolean {
  return (
    isSupabaseTimeout(error) ||
    isSessionVerificationUnavailable(error) ||
    Boolean(classifySupabaseUnreachable(describeThrown(error)))
  );
}

// 503, never 401: the client signs the person out on a 401 alone. The cookies are left untouched and
// the next heartbeat retries about a minute later.
function sessionServiceUnavailable() {
  return NextResponse.json(
    { error: "db_timeout", message: "Session service temporarily unavailable." },
    { status: 503 },
  );
}

export async function POST(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  const sessionToken = getCookieValue(cookieHeader, phoenixSessionCookieName);

  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request, token: sessionToken }),
      limit: 60,
      scope: "auth:heartbeat",
      windowMs: 60 * 1000,
    });
  } catch (error) {
    // The counting step reads the database too: during a restart it times out, and that is the same
    // outage the session read below already answers with a 503 — never a crash (APP-20D39617).
    if (!isApiRateLimitError(error)) {
      if (isSessionServiceOutage(error)) return sessionServiceUnavailable();
      throw error;
    }
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many heartbeat requests.",
        retryAfterSeconds: error.retryAfterSeconds,
      },
      { status: 429 },
    );
  }

  let sessionState: Awaited<ReturnType<typeof resolveSessionState>>;
  try {
    sessionState = await resolveSessionState(sessionToken, { refreshIdle: true });
  } catch (error) {
    // 503, never 401: the client signs the person out on a 401 alone, so answering 401 because the
    // database was briefly unreachable signs out everyone who happens to be working. The session
    // cookies are deliberately left untouched — the next heartbeat retries about a minute later.
    // A Cloudflare 52x page is the same outage as a timeout, seen from the other side: Supabase answered
    // through the edge that it was down. It used to be rethrown here as an unhandled 500.
    if (isSessionServiceOutage(error)) return sessionServiceUnavailable();
    throw error;
  }

  if (!sessionState) {
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
          // A test account stays one across the refresh — dropping this would turn it into the REAL
          // person it mirrors a few minutes in.
          testPersona: Boolean(devPreview.testPersona),
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
  const session = sessionState.payload;
  const idleTimeoutSeconds = sessionIdleTimeoutSecondsForRole(sessionState.access.role);
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
    absoluteExpiresAt: Math.floor(new Date(sessionState.appSession.absolute_expires_at).getTime() / 1000),
    expiresAt: refreshedExpiresAt,
    idleExpiresAt: Math.floor(new Date(sessionState.appSession.idle_expires_at).getTime() / 1000),
    ok: true,
  });
  response.cookies.set({
    httpOnly: true,
    maxAge: idleTimeoutSeconds,
    name: phoenixSessionCookieName,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    value: refreshed,
  });

  return response;
}
