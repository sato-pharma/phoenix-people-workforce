import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import {
  clearFailedLoginState,
  getRequestIp,
  getRequestUserAgent,
  isLoginRateLimited,
  registerFailedLoginAttempt,
  writeAuthAudit,
} from "@/lib/auth/audit";
import { authenticateLoginId, normalizeLoginId } from "@/lib/auth/credentials";
import { createSessionToken, phoenixSessionCookieName } from "@/lib/auth/session";
import {
  createSupabaseAuthSession,
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
  provisionSupabaseAuthIdentity,
} from "@/lib/auth/supabase-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const oneDaySeconds = 60 * 60 * 24;
const thirtyDaysSeconds = oneDaySeconds * 30;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      loginId?: string;
      password?: string;
      remember?: boolean;
    };
    const loginId = normalizeLoginId(payload.loginId ?? "");
    const ip = getRequestIp(request);
    const userAgent = getRequestUserAgent(request);

    if (await isLoginRateLimited(loginId, ip)) {
      await writeAuthAudit({
        actorLoginId: loginId || null,
        entityId: loginId || null,
        newValues: { ip, reason: "too_many_failures", userAgent },
        requestIp: ip,
        summary: "Login rate limited",
        userAgent,
      }).catch(() => undefined);

      return NextResponse.json(
        { error: "rate_limited", message: "Too many failed login attempts. Please try again later." },
        { status: 429 },
      );
    }

    const user = await authenticateLoginId(loginId, payload.password ?? "");

    if (!user) {
      if (loginId) {
        await registerFailedLoginAttempt({ ip, loginId, userAgent }).catch(() => undefined);
      }
      await writeAuthAudit({
        actorLoginId: loginId || null,
        entityId: loginId || null,
        newValues: { ip, userAgent },
        requestIp: ip,
        summary: "Login failed",
        userAgent,
      }).catch(() => undefined);

      return NextResponse.json(
        { error: "invalid_credentials", message: "Invalid login ID or password." },
        { status: 401 },
      );
    }

    const maxAgeSeconds = payload.remember ? thirtyDaysSeconds : oneDaySeconds;
    const password = payload.password ?? "";
    if (user.forcePasswordReset) {
      await writeAuthAudit({
        actorLoginId: user.loginId,
        actorHrId: user.hrId,
        actorRole: user.role,
        entityId: user.loginId,
        newValues: { ip, reason: "force_password_reset", userAgent },
        requestIp: ip,
        summary: "Login blocked: password reset required",
        userAgent,
      }).catch(() => undefined);

      return NextResponse.json(
        { error: "password_reset_required", message: "Password reset is required before access is restored." },
        { status: 403 },
      );
    }

    let sessionAuthUserId = user.authUserId ?? null;
    let supabaseSession:
      | {
          accessToken: string;
          refreshToken: string;
        }
      | null = null;
    let supabaseBridgeWarning: string | null = null;

    try {
      supabaseSession = await createSupabaseAuthSession(user.loginId, password);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create Supabase auth session.";
      const shouldRepairBridge =
        !user.authUserId ||
        !user.authEmail ||
        /checking email|email|user not found|invalid login credentials/i.test(message);

      if (!shouldRepairBridge) {
        supabaseBridgeWarning = message;
      } else {
        try {
          const repairedIdentity = await provisionSupabaseAuthIdentity({
            authUserId: user.authUserId ?? null,
            email: user.email ?? null,
            hrId: user.hrId,
            isActive: true,
            line: user.line ?? null,
            loginId: user.loginId,
            managerHrId: user.managerHrId ?? null,
            name: user.name ?? user.loginId,
            password,
            role: user.role,
          });
          sessionAuthUserId = repairedIdentity.authUserId;

          try {
            supabaseSession = await createSupabaseAuthSession(user.loginId, password);
          } catch (retryError) {
            const retryMessage =
              retryError instanceof Error
                ? retryError.message
                : "Failed to create Supabase auth session after bridge repair.";

            supabaseBridgeWarning = retryMessage;
          }
        } catch (repairError) {
          supabaseBridgeWarning =
            repairError instanceof Error
              ? repairError.message
              : "Failed to repair Supabase auth bridge.";
        }
      }
    }

    if (!supabaseSession && !supabaseBridgeWarning) {
      supabaseBridgeWarning =
        "Supabase auth bridge unavailable; continuing with Phoenix session only.";
    }

    if (!sessionAuthUserId) {
      await writeAuthAudit({
        actorLoginId: user.loginId,
        actorHrId: user.hrId,
        actorRole: user.role,
        entityId: user.loginId,
        newValues: {
          ip,
          reason: "missing_auth_user_link",
          supabaseBridgeWarning,
          userAgent,
        },
        requestIp: ip,
        summary: "Login blocked: auth identity linkage missing",
        userAgent,
      }).catch(() => undefined);

      return NextResponse.json(
        { error: "identity_unavailable", message: "Account identity reconciliation is incomplete. Please contact an administrator." },
        { status: 503 },
      );
    }

    const sessionId = randomUUID();
    const token = createSessionToken({
      authUserId: sessionAuthUserId,
      hrId: user.hrId,
      loginId: user.loginId,
      maxAgeSeconds,
      role: user.role,
      sessionId,
      sessionVersion: user.sessionVersion,
    });

    await clearFailedLoginState({ ip, loginId: user.loginId, userAgent }).catch(() => undefined);
    await writeAuthAudit({
      actorHrId: user.hrId,
      actorLoginId: user.loginId,
      actorRole: user.role,
      entityId: user.loginId,
      newValues: {
        authUserId: sessionAuthUserId,
        ip,
        remember: Boolean(payload.remember),
        role: user.role,
        sessionId,
        supabaseBridgeWarning,
        supabaseSessionAvailable: Boolean(supabaseSession),
        sessionVersion: user.sessionVersion,
        userAgent,
      },
      requestIp: ip,
      summary: "Login succeeded",
      userAgent,
    }).catch(() => undefined);

    const response = NextResponse.json({
      user: {
        hrId: user.hrId,
        loginId: user.loginId,
        role: user.role,
      },
      warning: supabaseBridgeWarning,
    });

    if (supabaseSession) {
      response.cookies.set({
        httpOnly: true,
        maxAge: maxAgeSeconds,
        name: phoenixSupabaseAccessTokenCookieName,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: supabaseSession.accessToken,
      });

      response.cookies.set({
        httpOnly: true,
        maxAge: maxAgeSeconds,
        name: phoenixSupabaseRefreshTokenCookieName,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: supabaseSession.refreshToken,
      });
    } else {
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
    }

    response.cookies.set({
      httpOnly: true,
      maxAge: maxAgeSeconds,
      name: phoenixSessionCookieName,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      value: token,
    });

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed.";
    return NextResponse.json({ error: "login_failed", message }, { status: 500 });
  }
}
