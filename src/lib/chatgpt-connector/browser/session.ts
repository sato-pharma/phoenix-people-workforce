/**
 * The capture browser's sign-in: a SHORT Phoenix session for the person who asked ChatGPT, minted for
 * one capture and revoked the moment it ends.
 *
 * The connector has already re-read that person's account live (identity.ts) before any tool runs, so
 * this mints nothing a website sign-in would not: the same `app_sessions` row and the same signed
 * `phoenix_session` cookie, for the same login, role and `session_version`. What differs:
 *   - It lives five minutes at most (idle and absolute), never the role's usual twelve hours — a film's
 *     render (films/render.ts) asks for its own length, capped at one hour.
 *   - It is marked by its user agent, "Phoenix ChatGPT connector capture", so the sessions list says
 *     what it was.
 *   - It is ALWAYS revoked afterwards (`revoked_reason` 'chatgpt_connector_capture'), success or not.
 *     A revoke that fails is logged; the row then dies of its own five-minute clock.
 *   - The cookie value never leaves the server: it goes straight into the capture browser.
 *
 * No password, no email, no sign-in alert, no Supabase session: the browser only reads pages.
 */
import { randomUUID } from "node:crypto";

import { createAppSession, revokeAppSession } from "@/lib/auth/app-sessions";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { createSessionToken, phoenixSessionCookieName } from "@/lib/auth/session-token";
import { logError } from "@/lib/observability/log";

import { readLiveAccount } from "../identity";
import { ToolRefusal } from "../types";

export const CAPTURE_SESSION_SECONDS = 300;
/** A film's render holds its session longer — its whole length plus page loads — never past an hour. */
export const FILM_SESSION_MAX_SECONDS = 3_600;
export const CAPTURE_SESSION_USER_AGENT = "Phoenix ChatGPT connector capture";
export const CAPTURE_SESSION_REVOKE_REASON = "chatgpt_connector_capture";

/**
 * Another reader of live pages (the expense case PDF, src/lib/outstation/approvals/case-pdf.ts) names
 * itself here, so the sessions list and the revoke reason say what the session really was.
 */
export type CaptureSessionMark = { userAgent: string; revokeReason: string };

export type CaptureSession = { cookieName: string; cookieValue: string; sessionId: string; revokeReason?: string };

export async function mintCaptureSession(
  ctx: AccessContext,
  seconds: number = CAPTURE_SESSION_SECONDS,
  mark?: CaptureSessionMark,
): Promise<CaptureSession> {
  const lifetime = Math.max(60, Math.min(FILM_SESSION_MAX_SECONDS, Math.round(seconds)));
  if (!ctx.loginId) throw new ToolRefusal("Sign in to Phoenix again.");
  const account = await readLiveAccount(ctx.loginId);
  if (!account || account.is_active === false || String(account.role) !== String(ctx.role)) {
    throw new ToolRefusal("Your Phoenix account changed. Reconnect Phoenix in ChatGPT.");
  }
  const sessionId = randomUUID();
  const sessionVersion = Number(account.session_version ?? 1);
  const role = ctx.role as PhoenixRole;
  const hrId = (account.hr_id as string | null) ?? ctx.hrId ?? null;
  await createAppSession({
    absoluteTimeoutSeconds: lifetime,
    hrId,
    idleTimeoutSeconds: lifetime,
    ip: null,
    loginId: String(account.login_id),
    role,
    sessionId,
    sessionVersion,
    supabaseSessionAvailable: false,
    supabaseSessionRequired: false,
    userAgent: mark?.userAgent ?? CAPTURE_SESSION_USER_AGENT,
  });
  const cookieValue = createSessionToken({
    hrId,
    loginId: String(account.login_id),
    maxAgeSeconds: lifetime,
    role,
    sessionId,
    sessionVersion,
  });
  return { cookieName: phoenixSessionCookieName, cookieValue, sessionId, ...(mark ? { revokeReason: mark.revokeReason } : {}) };
}

export async function revokeCaptureSession(session: CaptureSession | null): Promise<void> {
  if (!session) return;
  try {
    await revokeAppSession(session.sessionId, session.revokeReason ?? CAPTURE_SESSION_REVOKE_REASON);
  } catch (error) {
    logError("ChatGPT connector capture session revoke failed", {
      labels: { event: "chatgpt_connector_capture_revoke_failed" },
      error,
    });
  }
}
