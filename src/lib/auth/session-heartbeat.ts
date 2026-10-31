import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
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
  // The one loopback gate; this file kept its own URL-only copy until 2026-10-26.
  isLocalDevelopmentRequest,
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
import { classifyCloudflareGatewayPage, classifySupabaseUnreachable } from "@/lib/error-monitor/supabase-unreachable";

/**
 * THE SESSION HEARTBEAT — the one live read that keeps a signed-in page signed in.
 *
 * It lived inside app/api/auth/heartbeat/route.ts until 24 Oct 2026 and moved here unchanged so a
 * second route can run it: /api/auth/pulse carries this heartbeat, the sidebar badge counts and the
 * notification list in ONE request, which takes a visible tab from four session reads a minute to
 * two. Both routes call `runSessionHeartbeat` and both answer with `heartbeatResponse`, so there is
 * exactly one copy of the rate limit, the outage branch, the dev-preview refresh, the three cookie
 * clears and the cookie rotation.
 *
 * It deliberately does NOT resolve an access context (resolveAccessContext): the seat-view gate
 * refuses every non-read but the exit, and the test-account gate refuses a test account's writes, so
 * resolving one here would stop a seat view and a test login from ever refreshing their session. The
 * heartbeat is the session's own keep-alive, not a business read — anything a caller then serves off
 * the back of it layers the view itself (see /api/auth/pulse).
 */

/** One cookie the heartbeat sets, in the shape NextResponse.cookies.set takes. */
export type HeartbeatCookie = {
  httpOnly: boolean;
  maxAge: number;
  name: string;
  path: string;
  sameSite: "lax";
  secure: boolean;
  value: string;
};

export type SessionHeartbeatResult = {
  /**
   * The viewer whose session was just confirmed — the OWNER's own context, before any View as Seat
   * is layered on it. Null when the heartbeat answered 429, 503 or 401, which is every case where no
   * session was confirmed and nothing may be served off the back of it.
   */
  access: AccessContext | null;
  body: Record<string, unknown>;
  cookies: HeartbeatCookie[];
  status: number;
};

/**
 * True when the heartbeat failed because the DATABASE was slow or down, not because the session is
 * bad. A Cloudflare 52x page is the same outage as a timeout, seen from the other side. Both of the
 * heartbeat’s database steps use this one test: until 23 Oct 2026 only the session read did, and the
 * request-counting step before it rethrew its timeout, so every open page crashed with a 500 during
 * each database restart — 106 times for 50 people, mostly 22 Oct 12:00-15:00 Cairo (APP-20D39617).
 * Cloudflare's PLAIN gateway page counts too: every step here is a database read, so that page can only be
 * Supabase's edge. It crashed the pulse with a 500 on 26 and 30 Oct (System Audit, 31 Oct 2026).
 */
function isSessionServiceOutage(error: unknown): boolean {
  if (isSupabaseTimeout(error) || isSessionVerificationUnavailable(error)) return true;
  const described = describeThrown(error);
  return Boolean(classifySupabaseUnreachable(described) ?? classifyCloudflareGatewayPage(described));
}

// 503, never 401: the client signs the person out on a 401 alone. The cookies are left untouched and
// the next heartbeat retries about a minute later.
function sessionServiceUnavailable(): SessionHeartbeatResult {
  return {
    access: null,
    body: { error: "db_timeout", message: "Session service temporarily unavailable." },
    cookies: [],
    status: 503,
  };
}

/**
 * Runs the heartbeat and hands back what to answer: the body, the status, the cookies to set, and
 * the confirmed viewer when there is one. Every branch is the one the route answered before.
 */
export async function runSessionHeartbeat(request: Request): Promise<SessionHeartbeatResult> {
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
    return {
      access: null,
      body: {
        error: "rate_limited",
        message: "Too many heartbeat requests.",
        retryAfterSeconds: error.retryAfterSeconds,
      },
      cookies: [],
      status: 429,
    };
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
      return {
        access: devPreview,
        body: {
          expiresAt: refreshedExpiresAt,
          idleExpiresAt: refreshedExpiresAt,
          ok: true,
        },
        cookies: [
          {
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
          },
        ],
        status: 200,
      };
    }

    return {
      access: null,
      body: { error: "session_expired", message: "Session expired." },
      cookies: [
        expiredCookie(phoenixSessionCookieName),
        expiredCookie(phoenixSupabaseAccessTokenCookieName),
        expiredCookie(phoenixSupabaseRefreshTokenCookieName),
      ],
      status: 401,
    };
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

  return {
    access: sessionState.access,
    body: {
      absoluteExpiresAt: Math.floor(new Date(sessionState.appSession.absolute_expires_at).getTime() / 1000),
      expiresAt: refreshedExpiresAt,
      idleExpiresAt: Math.floor(new Date(sessionState.appSession.idle_expires_at).getTime() / 1000),
      ok: true,
    },
    cookies: [
      {
        httpOnly: true,
        maxAge: idleTimeoutSeconds,
        name: phoenixSessionCookieName,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: refreshed,
      },
    ],
    status: 200,
  };
}

/**
 * One of the three session cookies, cleared. Declared BELOW the heartbeat on purpose: three pins
 * (session-unavailable-keeps-session, supabase-unreachable, auth-session) read this file as text and
 * slice from the outage test to the first `throw error`, then require that slice to carry no
 * `status: 401` and no `maxAge: 0` — the proof that an unreachable database never signs anyone out.
 * A `maxAge: 0` written above the heartbeat would land inside that slice and read as a cookie clear
 * in the outage branch, which is exactly the defect those pins exist to catch.
 */
function expiredCookie(name: string): HeartbeatCookie {
  return {
    httpOnly: true,
    maxAge: 0,
    name,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    value: "",
  };
}

/**
 * The heartbeat's own response. `extra` is merged into the body for a caller that serves more off
 * the back of the same confirmed session (the pulse's badges and notices) — it can only ADD keys,
 * never change the session fields the client reads.
 */
export function heartbeatResponse(
  result: SessionHeartbeatResult,
  extra?: Record<string, unknown>,
): NextResponse {
  const response = NextResponse.json(extra ? { ...result.body, ...extra } : result.body, {
    status: result.status,
  });
  for (const cookie of result.cookies) response.cookies.set(cookie);
  return response;
}

/** The session token the heartbeat read, for a caller that must layer a View as Seat on it. */
export function heartbeatSessionToken(request: Request): string | null | undefined {
  return getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName);
}
