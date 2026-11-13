import { NextResponse } from "next/server";

import { getRequestIp, writeAuthAudit } from "@/lib/auth/audit";
import {
  otpauthUri,
  secondStepRequiredForRole,
  secretForTyping,
  trustedDeviceCookieName,
} from "@/lib/auth/second-step";
import { accountPasswordMatches, listOtherSecondStepAccounts } from "@/lib/auth/second-step-management";
import {
  beginSecondStepSetup,
  finishSecondStepSetup,
  forgetTrustedDevices,
  readSecondStepStatus,
  renewRecoveryCodes,
  resetSecondStep,
  secondStepIsSetUp,
} from "@/lib/auth/second-step-store";
import { resolveSessionState } from "@/lib/auth/server";
import { getCookieValue, phoenixSessionCookieName } from "@/lib/auth/session";
import { describeUnexpectedError } from "@/lib/http/api-errors";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { rejectUntrustedForwardedOrigin } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" } as const;

/**
 * THE SECOND SIGN-IN STEP, AS THE ACCOUNT'S OWN SCREEN MANAGES IT (src/lib/auth/second-step.ts).
 *
 * Who may call: a signed-in Super Admin, acting as themselves. The session is read from its cookie here,
 * never from a header, and a session that is viewing as another seat is refused: these changes belong
 * to the person, not to whoever they are looking at.
 *
 * 🔴 Every answer is scoped to the caller's own account, with ONE exception that is named, not implied:
 * `reset_other`, where a Super Admin returns ANOTHER Super Admin account to "not set up" (the owner's
 * "Recovery codes plus your reset", 13 Nov 2026). It takes the caller's own password and writes an audit
 * row naming both accounts.
 */
type SessionCheck = { failure: "unauthenticated" | "forbidden" } | { loginId: string };

async function requireSuperAdminSession(request: Request): Promise<SessionCheck> {
  const sessionToken = getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName);
  const sessionState = await resolveSessionState(sessionToken, { allowRecentCopy: false });
  const access = sessionState?.access;
  if (!access?.loginId) return { failure: "unauthenticated" as const };
  if (access.seatView || !secondStepRequiredForRole(access.role)) return { failure: "forbidden" as const };
  return { loginId: access.loginId };
}

function refuse(failure: "unauthenticated" | "forbidden") {
  return failure === "unauthenticated"
    ? NextResponse.json({ error: "unauthenticated", message: "You must be signed in." }, { status: 401 })
    : NextResponse.json(
        { error: "forbidden", message: "The second sign-in step is managed by a Super Admin from their own account." },
        { status: 403 },
      );
}

export async function GET(request: Request) {
  try {
    const session = await requireSuperAdminSession(request);
    if ("failure" in session) return refuse(session.failure);

    const [status, others] = await Promise.all([
      readSecondStepStatus(session.loginId),
      listOtherSecondStepAccounts(session.loginId),
    ]);
    return NextResponse.json({ others, status }, { headers: NO_STORE });
  } catch (error) {
    console.error("[auth/second-step] read failed", describeUnexpectedError(error));
    return NextResponse.json(
      { error: "read_failed", message: "Could not load your second sign-in step." },
      { status: 500 },
    );
  }
}

type Action = "begin_setup" | "finish_setup" | "new_recovery_codes" | "forget_devices" | "reset" | "reset_other";
const ACTIONS: readonly Action[] = ["begin_setup", "finish_setup", "new_recovery_codes", "forget_devices", "reset", "reset_other"];
/**
 * The changes that ask for the caller's password again (second-step-management.ts says why a password).
 * 🔴 `begin_setup` is one of them: it hands over a key, and a session somebody else is using (an unlocked
 * laptop, a copied cookie) must not be able to put THEIR phone on an account that is not set up yet.
 * `finish_setup` needs none: it only works with a code from a key that `begin_setup` handed to this person.
 */
const PASSWORD_ACTIONS: ReadonlySet<Action> = new Set<Action>(["begin_setup", "new_recovery_codes", "reset", "reset_other"]);

export async function POST(request: Request) {
  try {
    const originRejection = rejectUntrustedForwardedOrigin(request);
    if (originRejection) {
      return NextResponse.json({ error: "invalid_origin", message: "Request origin is not trusted." }, { status: 400 });
    }

    const session = await requireSuperAdminSession(request);
    if ("failure" in session) return refuse(session.failure);
    const { loginId } = session;
    const ip = getRequestIp(request);

    try {
      await assertApiRateLimit({
        identifier: rateLimitIdentity({ actor: loginId, request }),
        limit: 10,
        scope: "auth:second-step",
        windowMs: 15 * 60 * 1000,
      });
    } catch (error) {
      if (!isApiRateLimitError(error)) throw error;
      return NextResponse.json(
        { error: "rate_limited", message: "Too many attempts. Please wait before trying again." },
        { status: 429 },
      );
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "invalid_request", message: "Request body must be a JSON object." }, { status: 400 });
    }

    const action = ACTIONS.find((candidate) => candidate === body.action);
    if (!action) {
      return NextResponse.json({ error: "validation_error", message: "Unknown action." }, { status: 400 });
    }

    if (PASSWORD_ACTIONS.has(action)) {
      const password = typeof body.password === "string" ? body.password : "";
      if (!(await accountPasswordMatches(loginId, password))) {
        await writeAuthAudit({
          actorLoginId: loginId,
          entityId: loginId,
          newValues: { action, ip, reason: "wrong_password" },
          summary: "Second sign-in step change refused: wrong password",
        }).catch(() => undefined);
        return NextResponse.json(
          { error: "wrong_password", message: "That is not your current password." },
          { status: 403 },
        );
      }
    }

    if (action === "begin_setup") {
      if (await secondStepIsSetUp(loginId)) {
        return NextResponse.json(
          { error: "already_set_up", message: "Your second sign-in step is already set up." },
          { status: 409 },
        );
      }
      const { secret } = await beginSecondStepSetup(loginId);
      return NextResponse.json(
        {
          setup: {
            account: loginId,
            otpauthUri: otpauthUri({ account: loginId, secret }),
            secret,
            secretForTyping: secretForTyping(secret),
          },
        },
        { headers: NO_STORE },
      );
    }

    if (action === "finish_setup") {
      const finished = await finishSecondStepSetup({ code: body.code, loginId });
      if (!finished) {
        return NextResponse.json(
          { error: "second_step_invalid", message: "That code is not right, or the key expired. Start the set-up again." },
          { status: 400 },
        );
      }
      await writeAuthAudit({
        actorLoginId: loginId,
        entityId: loginId,
        newValues: { ip, recoveryCodes: finished.recoveryCodes.length, where: "profile" },
        summary: "Second sign-in step set up",
      }).catch(() => undefined);
      return NextResponse.json({ recoveryCodes: finished.recoveryCodes }, { headers: NO_STORE });
    }

    if (action === "new_recovery_codes") {
      if (!(await secondStepIsSetUp(loginId))) {
        return NextResponse.json(
          { error: "not_set_up", message: "Set up your second sign-in step first." },
          { status: 409 },
        );
      }
      const recoveryCodes = await renewRecoveryCodes(loginId);
      await writeAuthAudit({
        actorLoginId: loginId,
        entityId: loginId,
        newValues: { ip, recoveryCodes: recoveryCodes.length },
        summary: "Second sign-in step: new recovery codes made",
      }).catch(() => undefined);
      return NextResponse.json({ recoveryCodes }, { headers: NO_STORE });
    }

    if (action === "forget_devices") {
      await forgetTrustedDevices(loginId);
      await writeAuthAudit({
        actorLoginId: loginId,
        entityId: loginId,
        newValues: { ip },
        summary: "Second sign-in step: remembered browsers forgotten",
      }).catch(() => undefined);
      const response = NextResponse.json({ success: true });
      // This browser's own cookie goes too; its row is already gone.
      response.cookies.set({
        httpOnly: true,
        maxAge: 0,
        name: trustedDeviceCookieName,
        path: "/api/auth",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        value: "",
      });
      return response;
    }

    if (action === "reset") {
      const removed = await resetSecondStep(loginId);
      await writeAuthAudit({
        actorLoginId: loginId,
        entityId: loginId,
        newValues: { ip, removed },
        summary: "Second sign-in step reset by the account itself",
      }).catch(() => undefined);
      return NextResponse.json({ success: true });
    }

    // reset_other: the one action that touches an account that is not the caller's.
    const target = typeof body.loginId === "string" ? body.loginId.trim() : "";
    const others = await listOtherSecondStepAccounts(loginId);
    const other = others.find((candidate) => candidate.loginId === target);
    if (!other) {
      return NextResponse.json(
        { error: "not_found", message: "That account is not one whose second sign-in step you can reset." },
        { status: 404 },
      );
    }
    const removed = await resetSecondStep(other.loginId);
    await writeAuthAudit({
      actorLoginId: loginId,
      entityId: other.loginId,
      newValues: { ip, removed, resetBy: loginId },
      summary: "Second sign-in step reset by a Super Admin",
    }).catch(() => undefined);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[auth/second-step] change failed", describeUnexpectedError(error));
    return NextResponse.json(
      { error: "change_failed", message: "Could not change your second sign-in step." },
      { status: 500 },
    );
  }
}
