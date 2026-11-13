import { NextResponse } from "next/server";

import { getRequestIp, writeAuthAudit } from "@/lib/auth/audit";
import { resolveSessionState } from "@/lib/auth/server";
import { getCookieValue, phoenixSessionCookieName } from "@/lib/auth/session";
import { completeRegistration, resolveRelyingParty } from "@/lib/auth/webauthn";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { rejectUntrustedForwardedOrigin } from "@/lib/security/origins";

import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { describeUnexpectedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 2 of enrolling this device: verify what the device signed, then store its public key.
// No password here: it only accepts the single-use challenge step 1 issued to this login, and step 1 is
// where a Super Admin's password is asked.
export async function POST(request: Request) {
  try {
    const originRejection = rejectUntrustedForwardedOrigin(request);
    if (originRejection) {
      return NextResponse.json(
        { error: "invalid_origin", message: "Request origin is not trusted." },
        { status: 400 },
      );
    }

    const sessionToken = getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName);
    const sessionState = await resolveSessionState(sessionToken, { allowRecentCopy: false });

    if (!sessionState || !sessionState.access.loginId) {
      return NextResponse.json(
        { error: "unauthenticated", message: "You must be signed in to set up biometric sign-in." },
        { status: 401 },
      );
    }

    const loginId = sessionState.access.loginId;
    const ip = getRequestIp(request);

    try {
      await assertApiRateLimit({
        identifier: rateLimitIdentity({ actor: loginId, request }),
        limit: 10,
        scope: "auth:biometric-register",
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

    const { response } = body as Record<string, unknown>;
    if (!response || typeof response !== "object") {
      return NextResponse.json(
        { error: "invalid_request", message: "Missing the device's registration response." },
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

    const outcome = await completeRegistration({
      // A test login's hrId is the real person it mirrors; its passkey is its own (test-persona.ts).
      hrId: sessionState.access.testPersona ? null : sessionState.access.hrId ?? null,
      loginId,
      relyingParty,
      response: response as RegistrationResponseJSON,
      userAgent: request.headers.get("user-agent"),
    });

    if (!outcome.ok) {
      await writeAuthAudit({
        actorLoginId: loginId,
        entityId: loginId,
        newValues: { ip, reason: outcome.reason },
        summary: "Biometric enrollment rejected",
      }).catch(() => undefined);

      const message =
        outcome.reason === "challenge_expired"
          ? "That took too long. Please try setting up biometric sign-in again."
          : "This device could not be verified. Please try again.";

      return NextResponse.json({ error: outcome.reason, message }, { status: 400 });
    }

    await writeAuthAudit({
      actorLoginId: loginId,
      entityId: loginId,
      newValues: { deviceLabel: outcome.deviceLabel, ip, rpId: relyingParty.rpId },
      summary: "Biometric device enrolled",
    }).catch(() => undefined);

    return NextResponse.json({ deviceLabel: outcome.deviceLabel, success: true });
  } catch (error) {
    console.error(
      "[auth/biometric/register/verify] failed",
      describeUnexpectedError(error),
    );
    return NextResponse.json(
      { error: "register_failed", message: "Biometric setup failed. Please try again." },
      { status: 500 },
    );
  }
}
