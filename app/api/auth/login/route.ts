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
  persistSupabaseAuthIdentityLink,
  phoenixSupabaseAccessTokenCookieName,
  phoenixSupabaseRefreshTokenCookieName,
  provisionSupabaseAuthIdentity,
} from "@/lib/auth/supabase-identity";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import {
  rejectUntrustedForwardedOrigin,
  trustedOriginForRedirect,
} from "@/lib/security/origins";

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

class InvalidLoginPayloadError extends Error {
  constructor(message = "Login request body must be valid JSON.") {
    super(message);
    this.name = "InvalidLoginPayloadError";
  }
}

function parseJsonLoginPayload(payload: unknown): LoginPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidLoginPayloadError("Login request body must be a JSON object.");
  }

  const record = payload as Record<string, unknown>;
  const loginId = record.loginId;
  const password = record.password;
  const remember = record.remember;

  if (
    (loginId !== undefined && typeof loginId !== "string") ||
    (password !== undefined && typeof password !== "string") ||
    (remember !== undefined && typeof remember !== "boolean")
  ) {
    throw new InvalidLoginPayloadError("Login request body has invalid fields.");
  }

  return { loginId, password, remember };
}

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

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    throw new InvalidLoginPayloadError();
  }

  const parsedPayload = parseJsonLoginPayload(payload);

  return {
    ...parsedPayload,
    responseMode: "json",
  };
}

function getRedirectUrl(request: Request, pathname: string) {
  return new URL(pathname, trustedOriginForRedirect(request));
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

function serializeLoginError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;

    return {
      code: typeof record.code === "string" ? record.code : undefined,
      details: typeof record.details === "string" ? record.details : undefined,
      hint: typeof record.hint === "string" ? record.hint : undefined,
      message: typeof record.message === "string" ? record.message : "Non-Error login failure.",
      name: typeof record.name === "string" ? record.name : undefined,
    };
  }

  return {
    message: typeof error === "string" ? error : "Login failed.",
  };
}

export async function POST(request: Request) {
  try {
    const payload = await readLoginPayload(request);
    const loginId = normalizeLoginId(payload.loginId ?? "");
    const ip = getRequestIp(request);
    const originRejection = rejectUntrustedForwardedOrigin(request);

    if (originRejection) {
      await writeAuthAudit({
        actorLoginId: loginId || null,
        entityId: loginId || null,
        newValues: { ip, ...originRejection },
        summary: "Login blocked: untrusted request origin",
      }).catch(() => undefined);

      return loginFailureResponse(
        request,
        payload,
        "invalid_origin",
        "Login request origin is not trusted.",
        400,
      );
    }

    try {
      await assertApiRateLimit({
        identifier: rateLimitIdentity({ actor: loginId || null, request }),
        limit: 20,
        scope: "auth:login",
        windowMs: 15 * 60 * 1000,
      });
    } catch (error) {
      if (!isApiRateLimitError(error)) throw error;

      await writeAuthAudit({
        actorLoginId: loginId || null,
        entityId: loginId || null,
        newValues: { ip, reason: "api_rate_limit", retryAfterSeconds: error.retryAfterSeconds },
        summary: "Login API rate limited",
      }).catch(() => undefined);

      return loginFailureResponse(
        request,
        payload,
        "rate_limited",
        "Too many login requests. Please try again later.",
        429,
      );
    }

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
    const absoluteTimeoutSeconds = sessionAbsoluteTimeoutSecondsForRole(user.role);
    const supabaseSessionRequired = isSupabaseBridgeRequiredForRole(user.role);
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
          await persistSupabaseAuthIdentityLink({
            authEmail: repairedIdentity.authEmail,
            authUserId: repairedIdentity.authUserId,
            coarseRole: repairedIdentity.coarseRole,
            email: user.email ?? null,
            hrId: user.hrId,
            isActive: true,
            line: user.line ?? null,
            loginId: user.loginId,
            managerHrId: user.managerHrId ?? null,
            name: user.name ?? user.loginId,
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

    if (!supabaseSession && shouldBlockLoginWhenSupabaseBridgeUnavailable(user.role)) {
      await writeAuthAudit({
        actorLoginId: user.loginId,
        entityId: user.loginId,
        newValues: {
          ip,
          reason: "supabase_bridge_required",
          role: user.role,
          supabaseBridgeWarning,
        },
        summary: "Login blocked: privileged Supabase bridge unavailable",
      }).catch(() => undefined);

      return loginFailureResponse(
        request,
        payload,
        "auth_bridge_unavailable",
        "Login temporarily unavailable for this role. Please contact your Phoenix admin.",
        503,
      );
    }

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
      supabaseSessionAvailable: Boolean(supabaseSession),
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
        ip,
        remember: Boolean(payload.remember),
        role: user.role,
        absoluteExpiresAt: appSession.absoluteExpiresAt,
        idleExpiresAt: appSession.idleExpiresAt,
        sessionId,
        supabaseBridgeWarning,
        supabaseSessionRequired,
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
      maxAge: maxAgeSeconds,
      name: phoenixSessionCookieName,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      value: token,
    });

    return response;
  } catch (error) {
    if (error instanceof InvalidLoginPayloadError) {
      return NextResponse.json(
        { error: "invalid_request", message: error.message },
        { status: 400 },
      );
    }

    const diagnostic = serializeLoginError(error);
    console.error("[auth/login] failed", diagnostic);

    return NextResponse.json(
      { error: "login_failed", message: "Login failed." },
      { status: 500 },
    );
  }
}
