import { NextResponse } from "next/server";

import {
  sessionAbsoluteTimeoutSecondsForRole,
} from "@/lib/auth/app-sessions";
import {
  changeUserPassword,
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
  SamePasswordError,
  WrongCurrentPasswordError,
} from "@/lib/auth/change-password";
import { getRequestIp } from "@/lib/auth/audit";
import {
  createSessionToken,
  getCookieValue,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
} from "@/lib/auth/session";
import { resolveSessionState } from "@/lib/auth/server";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { describeUnexpectedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const cookieHeader = request.headers.get("cookie");
    const sessionToken = getCookieValue(cookieHeader, phoenixSessionCookieName);
    const sessionState = await resolveSessionState(sessionToken, { allowRecentCopy: false });

    if (!sessionState || !sessionState.access.loginId) {
      return NextResponse.json(
        { error: "unauthenticated", message: "You must be signed in to change your password." },
        { status: 401 },
      );
    }

    const { access, payload } = sessionState;
    const loginId = access.loginId!;
    const ip = getRequestIp(request);

    try {
      await assertApiRateLimit({
        identifier: rateLimitIdentity({ actor: loginId, request }),
        limit: 5,
        scope: "auth:change-password",
        windowMs: 15 * 60 * 1000,
      });
    } catch (error) {
      if (!isApiRateLimitError(error)) throw error;
      return NextResponse.json(
        { error: "rate_limited", message: "Too many attempts. Please wait before trying again." },
        { status: 429 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "invalid_request", message: "Request body must be valid JSON." },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "invalid_request", message: "Request body must be an object." },
        { status: 400 },
      );
    }

    const { currentPassword, newPassword, confirmPassword } = body as Record<string, unknown>;

    if (typeof currentPassword !== "string" || !currentPassword) {
      return NextResponse.json(
        { error: "validation_error", message: "Current password is required." },
        { status: 400 },
      );
    }

    if (typeof newPassword !== "string" || !newPassword) {
      return NextResponse.json(
        { error: "validation_error", message: "New password is required." },
        { status: 400 },
      );
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: "validation_error", message: "New password must be at least 8 characters." },
        { status: 400 },
      );
    }

    // Server-side confirm check (client-side alone is not sufficient).
    if (typeof confirmPassword !== "string" || confirmPassword !== newPassword) {
      return NextResponse.json(
        { error: "validation_error", message: "Passwords do not match." },
        { status: 400 },
      );
    }

    const result = await changeUserPassword({
      currentPassword,
      ip,
      loginId,
      newPassword,
      sessionId: payload.sid,
    });

    // If the app_sessions row for this session was revoked or missing by the time
    // we tried to update it, we cannot issue a valid token. The password IS changed —
    // tell the user to sign in fresh with the new password.
    if (result.sessionRefreshRequired) {
      return NextResponse.json(
        {
          error: "session_refresh_required",
          message: "Your password was changed. Please sign in again with your new password.",
          requiresRelogin: true,
          success: true,
        },
        { status: 200 },
      );
    }

    // Compute max-age for the re-issued session token using the REMAINING absolute
    // timeout of the existing session, capped to the idle timeout. This preserves
    // the original absolute expiry instead of silently extending it.
    const idleTimeoutSeconds = sessionIdleTimeoutSecondsForRole(access.role);
    const remainingAbsoluteSeconds = result.absoluteExpiresAt
      ? Math.max(60, Math.floor((new Date(result.absoluteExpiresAt).getTime() - Date.now()) / 1000))
      : sessionAbsoluteTimeoutSecondsForRole(access.role);
    const maxAgeSeconds = Math.min(idleTimeoutSeconds, remainingAbsoluteSeconds);

    const newToken = createSessionToken({
      hrId: access.hrId ?? null,
      loginId,
      maxAgeSeconds,
      role: access.role,
      sessionId: payload.sid,
      sessionVersion: result.newSessionVersion,
    });

    const response = NextResponse.json({ success: true });

    response.cookies.set({
      httpOnly: true,
      maxAge: maxAgeSeconds,
      name: phoenixSessionCookieName,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      value: newToken,
    });

    // For bridge-required roles (CEO, Super Admin, etc.) refresh the Supabase
    // access token cookie so their Supabase-backed queries keep working.
    if (result.supabaseSession) {
      response.cookies.set({
        httpOnly: true,
        name: phoenixSupabaseAccessTokenCookieName,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: result.supabaseSession.accessToken,
      });
      response.cookies.set({
        httpOnly: true,
        name: phoenixSupabaseRefreshTokenCookieName,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: result.supabaseSession.refreshToken,
      });
    }

    return response;
  } catch (error) {
    if (error instanceof WrongCurrentPasswordError) {
      return NextResponse.json(
        { error: "wrong_password", message: error.message },
        { status: 401 },
      );
    }

    if (error instanceof SamePasswordError) {
      return NextResponse.json(
        { error: "same_password", message: error.message },
        { status: 400 },
      );
    }

    // Log full error server-side; return a generic message to avoid leaking
    // internal DB/infra details (table names, connection errors, etc.).
    console.error("[auth/change-password] failed", describeUnexpectedError(error));
    return NextResponse.json(
      { error: "change_failed", message: "Password change failed. Please try again or contact support." },
      { status: 500 },
    );
  }
}
