import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import {
  createAppSession,
  isSupabaseBridgeRequiredForRole,
  sessionAbsoluteTimeoutSecondsForRole,
  shouldBlockLoginWhenSupabaseBridgeUnavailable,
} from "@/lib/auth/app-sessions";
import {
  clearFailedLoginState,
  getRequestIp,
  isLoginRateLimited,
  writeAuthAudit,
} from "@/lib/auth/audit";
import { resolveAuthUserForPasswordlessLogin } from "@/lib/auth/credentials";
import { isIpBlocked } from "@/lib/auth/ip-blocklist";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import {
  createSessionToken,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
} from "@/lib/auth/session";
import {
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
} from "@/lib/auth/supabase-identity";
import { completeAuthentication, resolveRelyingParty } from "@/lib/auth/webauthn";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { rejectUntrustedForwardedOrigin } from "@/lib/security/origins";

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { describeUnexpectedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 2 of signing in: verify the signature, then mint exactly the session the password path mints.
//
// 🔴 THE RULE FOR THIS FILE: a passkey replaces the PASSWORD CHECK and nothing else. Every other
// gate app/api/auth/login/route.ts applies must appear here too, or biometrics becomes the way
// around them. Specifically: untrusted origin, API rate limit, IP blocklist, account lockout,
// is_active, terminal employment status, force_password_reset, and the audit trail. The one
// deliberate difference is the Supabase bridge — see the comment on that block below.
export async function POST(request: Request) {
  try {
    const originRejection = rejectUntrustedForwardedOrigin(request);
    if (originRejection) {
      return NextResponse.json(
        { error: "invalid_origin", message: "Request origin is not trusted." },
        { status: 400 },
      );
    }

    const ip = getRequestIp(request);

    try {
      await assertApiRateLimit({
        identifier: rateLimitIdentity({ actor: null, request }),
        limit: 30,
        scope: "auth:biometric-login",
        windowMs: 15 * 60 * 1000,
      });
    } catch (error) {
      if (!isApiRateLimitError(error)) throw error;
      return NextResponse.json(
        { error: "rate_limited", message: "Too many sign-in attempts. Please try again later." },
        { status: 429 },
      );
    }

    if (await isIpBlocked(ip)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many sign-in attempts. Please try again later." },
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

    const { response } = body as Record<string, unknown>;
    if (!response || typeof response !== "object") {
      return NextResponse.json(
        { error: "invalid_request", message: "Missing the device's sign-in response." },
        { status: 400 },
      );
    }

    const relyingParty = resolveRelyingParty(request);
    if (!relyingParty) {
      return NextResponse.json(
        {
          error: "unsupported_origin",
          message: "Biometric sign-in is only available over a secure connection.",
        },
        { status: 400 },
      );
    }

    // The cryptographic proof. Until this returns ok we do not know, and must not assume, who the
    // caller is.
    const outcome = await completeAuthentication({
      relyingParty,
      response: response as AuthenticationResponseJSON,
    });

    if (!outcome.ok) {
      await writeAuthAudit({
        actorLoginId: null,
        entityId: null,
        newValues: { ip, reason: outcome.reason },
        summary: "Biometric sign-in failed",
      }).catch(() => undefined);

      // One generic message for every failure mode: telling the caller whether a credential was
      // revoked, replayed, or simply unknown would hand an attacker a probe.
      return NextResponse.json(
        {
          error: "invalid_credentials",
          message: "Biometric sign-in failed. Please sign in with your password.",
        },
        { status: 401 },
      );
    }

    const loginId = outcome.loginId;

    // Account lockout applies to biometrics too — an account frozen after repeated password
    // failures must not be reachable through a side door.
    if (await isLoginRateLimited(loginId, ip)) {
      await writeAuthAudit({
        actorLoginId: loginId,
        entityId: loginId,
        newValues: { ip, reason: "too_many_failures" },
        summary: "Biometric sign-in rate limited",
      }).catch(() => undefined);

      return NextResponse.json(
        { error: "rate_limited", message: "Too many failed sign-in attempts. Please try again later." },
        { status: 429 },
      );
    }

    // Enforces is_active AND terminal employment status. A resigned employee holding an enrolled
    // phone is refused here.
    const user = await resolveAuthUserForPasswordlessLogin(loginId);

    if (!user) {
      await writeAuthAudit({
        actorLoginId: loginId,
        entityId: loginId,
        newValues: { ip, reason: "account_inactive_or_terminal" },
        summary: "Biometric sign-in blocked: account not eligible",
      }).catch(() => undefined);

      return NextResponse.json(
        {
          error: "invalid_credentials",
          message: "Biometric sign-in failed. Please sign in with your password.",
        },
        { status: 401 },
      );
    }

    if (user.forcePasswordReset) {
      await writeAuthAudit({
        actorLoginId: user.loginId,
        entityId: user.loginId,
        newValues: { ip, reason: "password_setup_required" },
        summary: "Biometric sign-in blocked: password setup required",
      }).catch(() => undefined);

      return NextResponse.json(
        {
          error: "password_setup_required",
          message: "Your password must be set or reset from the admin link before you can sign in.",
        },
        { status: 403 },
      );
    }

    // The Supabase auth bridge mints its session from the raw password (signInWithPassword), and a
    // biometric assertion cannot produce one — by design, that is the entire point of a passkey.
    // Today that costs nothing: the bridge is best-effort, PHOENIX_STRICT_SUPABASE_BRIDGE is opt-in
    // and off, and the password path already falls back to a Phoenix-only session that every page
    // works with (visibility here is application-scoped, not RLS-scoped).
    //
    // 🔴 But if that flag is ever switched on, a bridge-required role signing in biometrically would
    // silently get a WEAKER session than the same person gets with a password. Refuse instead, and
    // send them to the password field. Never let this path become the quiet way to skip the bridge.
    const supabaseSessionRequired = isSupabaseBridgeRequiredForRole(user.role);
    if (shouldBlockLoginWhenSupabaseBridgeUnavailable(user.role)) {
      await writeAuthAudit({
        actorLoginId: user.loginId,
        entityId: user.loginId,
        newValues: { ip, reason: "supabase_bridge_required", role: user.role },
        summary: "Biometric sign-in blocked: privileged role requires the Supabase bridge",
      }).catch(() => undefined);

      return NextResponse.json(
        {
          error: "auth_bridge_unavailable",
          message: "Please sign in with your password for this role.",
        },
        { status: 503 },
      );
    }

    const maxAgeSeconds = sessionIdleTimeoutSecondsForRole(user.role);
    const absoluteTimeoutSeconds = sessionAbsoluteTimeoutSecondsForRole(user.role);
    const sessionId = randomUUID();

    const appSession = await createAppSession({
      absoluteTimeoutSeconds,
      hrId: user.hrId,
      idleTimeoutSeconds: maxAgeSeconds,
      ip,
      loginId: user.loginId,
      role: user.role,
      sessionId,
      sessionVersion: user.sessionVersion,
      supabaseSessionAvailable: false,
      supabaseSessionRequired,
      userAgent: request.headers.get("user-agent"),
    });

    const token = createSessionToken({
      hrId: user.hrId,
      loginId: user.loginId,
      maxAgeSeconds,
      role: user.role,
      sessionId,
      sessionVersion: user.sessionVersion,
    });

    await clearFailedLoginState({ ip, loginId: user.loginId }).catch(() => undefined);
    await writeAuthAudit({
      actorLoginId: user.loginId,
      entityId: user.loginId,
      newValues: {
        absoluteExpiresAt: appSession.absoluteExpiresAt,
        idleExpiresAt: appSession.idleExpiresAt,
        ip,
        method: "biometric",
        role: user.role,
        sessionId,
        sessionVersion: user.sessionVersion,
        supabaseSessionRequired,
      },
      summary: "Login succeeded (biometric)",
    }).catch(() => undefined);

    const nextResponse = NextResponse.json({
      redirectTo: resolveLandingPathForRole(user.role),
      user: { hrId: user.hrId, loginId: user.loginId, role: user.role },
    });

    // No Supabase session exists on this path, so clear any stale bridge cookies rather than
    // leaving a previous session's tokens in place.
    for (const name of [phoenixSupabaseAccessTokenCookieName, phoenixSupabaseRefreshTokenCookieName]) {
      nextResponse.cookies.set({
        httpOnly: true,
        maxAge: 0,
        name,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: "",
      });
    }

    nextResponse.cookies.set({
      httpOnly: true,
      maxAge: maxAgeSeconds,
      name: phoenixSessionCookieName,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      value: token,
    });

    return nextResponse;
  } catch (error) {
    console.error(
      "[auth/biometric/login/verify] failed",
      describeUnexpectedError(error),
    );
    return NextResponse.json(
      { error: "login_failed", message: "Biometric sign-in failed." },
      { status: 500 },
    );
  }
}
