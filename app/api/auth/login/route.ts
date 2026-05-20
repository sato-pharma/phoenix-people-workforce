import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import {
  clearFailedLoginState,
  getRequestIp,
  isLoginRateLimited,
  registerFailedLoginAttempt,
  writeAuthAudit,
} from "@/lib/auth/audit";
import { authenticateLoginId, normalizeLoginId } from "@/lib/auth/credentials";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import {
  createSessionToken,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
} from "@/lib/auth/session";
import {
  createSupabaseAuthSession,
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
  provisionSupabaseAuthIdentity,
} from "@/lib/auth/supabase-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LoginPayload = {
  loginId?: string;
  password?: string;
  remember?: boolean;
};

type LoginRequestPayload = LoginPayload & {
  responseMode: "json" | "redirect";
};

async function readLoginPayload(request: Request): Promise<LoginRequestPayload> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData();

    return {
      loginId: String(formData.get("loginId") ?? ""),
      password: String(formData.get("password") ?? ""),
      remember: formData.has("remember"),
      responseMode: "redirect",
    };
  }

  const payload = (await request.json()) as LoginPayload;

  return {
    ...payload,
    responseMode: "json",
  };
}

function getRedirectUrl(request: Request, pathname: string) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim();

  if (forwardedHost) {
    return new URL(pathname, `${forwardedProto || "https"}://${forwardedHost}`);
  }

  const origin = request.headers.get("origin");

  if (origin) {
    try {
      return new URL(pathname, origin);
    } catch {
      // Fall back to the request URL below.
    }
  }

  return new URL(pathname, request.url);
}

function loginFailureResponse(
  request: Request,
  payload: LoginRequestPayload,
  error: string,
  message: string,
  status: number,
) {
  if (payload.responseMode === "redirect") {
    const url = getRedirectUrl(request, "/login");
    url.searchParams.set("error", error);

    return NextResponse.redirect(url, 303);
  }

  return NextResponse.json({ error, message }, { status });
}

export async function POST(request: Request) {
  try {
    const payload = await readLoginPayload(request);
    const loginId = normalizeLoginId(payload.loginId ?? "");
    const ip = getRequestIp(request);

    if (await isLoginRateLimited(loginId, ip)) {
      await writeAuthAudit({
        actorLoginId: loginId || null,
        entityId: loginId || null,
        newValues: { ip, reason: "too_many_failures" },
        summary: "Login rate limited",
      }).catch(() => undefined);

      return loginFailureResponse(
        request,
        payload,
        "rate_limited",
        "Too many failed login attempts. Please try again later.",
        429,
      );
    }

    const user = await authenticateLoginId(loginId, payload.password ?? "");

    if (!user) {
      if (loginId) {
        await registerFailedLoginAttempt({ ip, loginId }).catch(() => undefined);
      }
      await writeAuthAudit({
        actorLoginId: loginId || null,
        entityId: loginId || null,
        newValues: { ip },
        summary: "Login failed",
      }).catch(() => undefined);

      return loginFailureResponse(
        request,
        payload,
        "invalid_credentials",
        "Invalid login ID or password.",
        401,
      );
    }

    if (user.forcePasswordReset) {
      await writeAuthAudit({
        actorLoginId: user.loginId,
        entityId: user.loginId,
        newValues: { ip, reason: "password_setup_required" },
        summary: "Login blocked: password setup required",
      }).catch(() => undefined);

      return loginFailureResponse(
        request,
        payload,
        "password_setup_required",
        "Your password must be set or reset from the admin link before you can sign in.",
        403,
      );
    }

    const maxAgeSeconds = sessionIdleTimeoutSecondsForRole(user.role);
    const password = payload.password ?? "";
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
          await provisionSupabaseAuthIdentity({
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

    const sessionId = randomUUID();
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
        ip,
        remember: Boolean(payload.remember),
        role: user.role,
        sessionId,
        supabaseBridgeWarning,
        supabaseSessionAvailable: Boolean(supabaseSession),
        sessionVersion: user.sessionVersion,
      },
      summary: "Login succeeded",
    }).catch(() => undefined);

    const response = payload.responseMode === "redirect"
      ? NextResponse.redirect(getRedirectUrl(request, resolveLandingPathForRole(user.role)), 303)
      : NextResponse.json({
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
        name: phoenixSupabaseAccessTokenCookieName,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: supabaseSession.accessToken,
      });

      response.cookies.set({
        httpOnly: true,
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
