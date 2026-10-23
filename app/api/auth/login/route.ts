import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import {
  appSessionExpiryTimes,
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
import { isIpBlocked } from "@/lib/auth/ip-blocklist";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { isNativeClientRequest } from "@/lib/auth/native-session";
import {
  createSessionToken,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
} from "@/lib/auth/session";
import { isSupabasePasswordRefusal, shouldRepairSupabaseAuthBridge } from "@/lib/auth/supabase-bridge-repair";
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
import { afterResponse } from "@/lib/http/after-response";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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

// Hardcoded CI test account: only active when PHOENIX_CI_SMOKE_LOGIN=true.
// This account matches the credentials used in tests/e2e/auth.setup.ts.
const CI_SMOKE_LOGIN_ID = "a-12";
const CI_SMOKE_PASSWORD = "12345678";

function resolveCiSmokeUser(loginId: string, password: string) {
  if (
    loginId.toLowerCase() === CI_SMOKE_LOGIN_ID &&
    password === CI_SMOKE_PASSWORD
  ) {
    return {
      authEmail: null as string | null,
      authUserId: null as string | null,
      email: null as string | null,
      forcePasswordReset: false,
      hrId: "A-12",
      isTestPersona: false,
      line: null as string | null,
      loginId: CI_SMOKE_LOGIN_ID,
      managerHrId: null as string | null,
      name: "CI Test Account",
      role: "National Sales Manager" as const,
      sessionVersion: 1,
    };
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const payload = await readLoginPayload(request);
    const loginId = normalizeLoginId(payload.loginId ?? "");
    const ip = getRequestIp(request);
    // PHOENIX_CI_SMOKE_LOGIN=true bypasses ALL Supabase DB calls (rate-limit checks,
    // credential lookup, session insert). Only accepts the hardcoded CI test account.
    // Set by the login smoke test step in ci.yml's `validate` job, to guarantee login
    // succeeds there without requiring DB access. (That step used to be its own
    // `preview-smoke` job; it moved into `validate` and the separate job is gone.)
    // Gated on APP_ENV rather than NODE_ENV: Next.js inlines NODE_ENV to the literal
    // "production" at build time for every `next build` output -- including the build
    // that job's smoke test runs against -- so a NODE_ENV check would be dead code that
    // always resolves to false and would silently break that smoke test.
    const ciSmokeMode =
      process.env.APP_ENV !== "production" && process.env.PHOENIX_CI_SMOKE_LOGIN === "true";
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

    if (!ciSmokeMode) {
      // The cheap request cap runs ALONE first, so a login flood past it is refused for one database
      // call, as it always was. Only then are the two remaining gates — the failed-attempt lockout
      // and the blocklist — asked AT ONCE, and their answers read in the order they always were, so
      // the same request is refused for the same reason and with the same response as before; only
      // the wait is shorter (owner, 2026-10-23: "once I press login … never take more than 1
      // second"). Each answer is caught where it starts, so the blocklist's verdict, never read when
      // the lockout refuses, cannot surface as an unhandled rejection; the lockout's own failure
      // still ends the request in the 500 below, as it did when it ran alone.
      const apiCapCheck = assertApiRateLimit({
        identifier: rateLimitIdentity({ actor: loginId || null, request }),
        limit: 20,
        scope: "auth:login",
        windowMs: 15 * 60 * 1000,
      }).then(
        () => null,
        (error: unknown) => ({ error }),
      );
      const apiCap = await apiCapCheck;
      if (apiCap) {
        const { error } = apiCap;
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

      const lockoutCheck = isLoginRateLimited(loginId, ip).then(
        (limited) => ({ limited }),
        (error: unknown) => ({ error, limited: false }),
      );
      const blocklistCheck = isIpBlocked(ip).catch(() => false);

      const lockout = await lockoutCheck;
      if ("error" in lockout) throw lockout.error;
      if (lockout.limited) {
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

      // Admin-managed IP blocklist (System Issues security lens). Fail-open (isIpBlocked
      // never throws), and returns the SAME generic rate-limited response so a blocked
      // attacker gets no signal that their IP specifically is denied.
      if (await blocklistCheck) {
        await writeAuthAudit({
          actorLoginId: loginId || null,
          entityId: loginId || null,
          newValues: { ip, reason: "ip_blocked" },
          summary: "Login blocked: IP on blocklist",
        }).catch(() => undefined);

        return loginFailureResponse(
          request,
          payload,
          "rate_limited",
          "Too many failed login attempts. Please try again later.",
          429,
        );
      }
    }

    let user;
    if (ciSmokeMode) {
      user = resolveCiSmokeUser(loginId, payload.password ?? "");
    } else {
      user = await authenticateLoginId(loginId, payload.password ?? "");
    }

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

    // PHOENIX_SKIP_SUPABASE_AUTH_BRIDGE=true skips all Supabase Auth API calls.
    // Used in CI to prevent bridge network timeouts from blocking login.
    // A test account (src/lib/auth/test-persona.ts) never gets one either: it has no HR id of its own,
    // so the bridge would mint a Supabase user whose profile row its foreign key refuses — and nothing
    // a test account opens reads through the bridge.
    const skipBridge = process.env.PHOENIX_SKIP_SUPABASE_AUTH_BRIDGE === "true" || user.isTestPersona;

    if (!skipBridge) try {
      supabaseSession = await createSupabaseAuthSession(user.loginId, password);
    } catch (error) {
      // Classification lives in `shouldRepairSupabaseAuthBridge`, which reads the RAW message.
      // It used to read `clientSafeErrorMessage(…, { report: false })`'s — and that helper redacts
      // every Supabase error, so the text tested was the fallback sentence and the message pattern
      // could never match it. Repair was therefore skipped for every user who already had an
      // identity, which is precisely who it is for. The `{ report: false }` change earlier the same
      // day closed one door onto the `api_error_redacted` rows; the warning path below was the
      // other, and it stayed open. Reporting now happens only where a login really does end in a
      // warning: this branch, and the two failure paths after it.
      const shouldRepairBridge = shouldRepairSupabaseAuthBridge({
        authEmail: user.authEmail,
        authUserId: user.authUserId,
        error,
      });

      if (!shouldRepairBridge) {
        supabaseBridgeWarning = clientSafeErrorMessage(error, "Failed to create Supabase auth session.");
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
          }, { hotPath: true });
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
              clientSafeErrorMessage(retryError, "Failed to create Supabase auth session after bridge repair.");

            supabaseBridgeWarning = retryMessage;
          }
        } catch (repairError) {
          // A password GoTrue refuses as weak is not a bridge failure: Phoenix has already
          // authenticated this person, they are signed in, and the refusal repeats on every login
          // until the password changes. Reporting it through clientSafeErrorMessage writes an
          // app_error_events row per successful login — three for one Medical Representative in 28
          // seconds on 23 Oct 2026 — so this branch renders a plain literal, which reports nothing.
          // Every OTHER repair failure stays reported: that one really is the bridge.
          supabaseBridgeWarning = isSupabasePasswordRefusal(repairError)
            ? "Supabase auth bridge not repaired: Supabase refuses this account's password as too weak. Continuing with Phoenix session only."
            : clientSafeErrorMessage(repairError, "Failed to repair Supabase auth bridge.");
        }
      }
    } // end if (!skipBridge)

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
    let appSession;
    if (ciSmokeMode) {
      appSession = appSessionExpiryTimes({ absoluteTimeoutSeconds, idleTimeoutSeconds: maxAgeSeconds });
    } else {
      appSession = await createAppSession({
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
    }
    const token = createSessionToken({
      hrId: user.hrId,
      loginId: user.loginId,
      maxAgeSeconds,
      role: user.role,
      sessionId,
      sessionVersion: user.sessionVersion,
    });

    // The bookkeeping of a sign-in that has already succeeded — the success row, the lockout reset
    // and the audit line — runs AFTER the reply (src/lib/http/after-response.ts). Nothing in the
    // reply depends on it and both calls already swallowed their failures; awaited here it was four
    // more database round trips between the press and the page. The session row above is NOT
    // deferred: the very next request reads it.
    if (!ciSmokeMode) {
      // Read now, while the values are narrowed — the tasks run once this function has returned.
      const succeededLoginId = user.loginId;
      const successAudit = {
        actorLoginId: succeededLoginId,
        entityId: succeededLoginId,
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
      };
      await afterResponse("auth.login.clear_failed_state", () =>
        clearFailedLoginState({ ip, loginId: succeededLoginId }),
      );
      await afterResponse("auth.login.audit_success", () => writeAuthAudit(successAudit));
    }

    // The native app has no cookie jar we control, so it needs the token itself. Returned ONLY to a
    // caller that declares itself native (src/lib/auth/native-session.ts explains the trade), and
    // it is the same token, on the same clock, as the cookie set below — not a longer-lived one.
    // `landingPath` saves the app a round trip working out where this role starts.
    const nativeSession = isNativeClientRequest(request.headers)
      ? {
          expiresAt: new Date(Date.now() + maxAgeSeconds * 1000).toISOString(),
          landingPath: resolveLandingPathForRole(user.role),
          sessionToken: token,
        }
      : null;

    const response = payload.responseMode === "redirect"
      ? NextResponse.redirect(getRedirectUrl(request, resolveLandingPathForRole(user.role)), 303)
      : NextResponse.json({
          ...(nativeSession ?? {}),
          user: {
            hrId: user.hrId,
            loginId: user.loginId,
            role: user.role,
          },
          warning: supabaseBridgeWarning,
        });

    // A native caller authenticates by the bearer token in the body above — it has no cookie jar we
    // control and must carry NO cookie. React Native's Android networking persists whatever the login
    // response Set-Cookies and re-sends it on the next request, and a `phoenix_session` cookie then
    // rides every mutation: the CSRF guard reads that as a browser session and refuses it, so a second
    // login and every authenticated write returns `csrf_blocked` (measured against production
    // 2026-09-23). So we do the opposite of the web path here — actively CLEAR all three cookies
    // (Max-Age=0), which also removes any cookie a build before this fix left on the device. The token
    // the app actually uses is already in the JSON body via `nativeSession`.
    if (nativeSession) {
      for (const name of [
        phoenixSessionCookieName,
        phoenixSupabaseAccessTokenCookieName,
        phoenixSupabaseRefreshTokenCookieName,
      ]) {
        response.cookies.set({
          httpOnly: true,
          maxAge: 0,
          name,
          path: "/",
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          value: "",
        });
      }
      return response;
    }

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
