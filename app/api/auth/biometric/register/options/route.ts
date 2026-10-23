import { NextResponse } from "next/server";

import { getRequestIp, writeAuthAudit } from "@/lib/auth/audit";
import { resolveSessionState } from "@/lib/auth/server";
import { getCookieValue, phoenixSessionCookieName } from "@/lib/auth/session";
import { buildRegistrationOptions, resolveRelyingParty } from "@/lib/auth/webauthn";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { rejectUntrustedForwardedOrigin } from "@/lib/security/origins";
import { describeUnexpectedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 1 of enrolling this device: hand the browser a challenge to sign.
// Enrollment is only ever possible from INSIDE a live session — you prove who you are with your
// password first, then bind a device to that identity.
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

    // displayName only labels the entry in the phone's own passkey list; the login ID is what the
    // person recognises there, and it avoids a second lookup on the enrollment hot path.
    const options = await buildRegistrationOptions({
      displayName: loginId,
      loginId,
      relyingParty,
    });

    await writeAuthAudit({
      actorLoginId: loginId,
      entityId: loginId,
      newValues: { ip: getRequestIp(request), rpId: relyingParty.rpId },
      summary: "Biometric enrollment started",
    }).catch(() => undefined);

    return NextResponse.json({ options });
  } catch (error) {
    console.error(
      "[auth/biometric/register/options] failed",
      describeUnexpectedError(error),
    );
    return NextResponse.json(
      { error: "options_failed", message: "Could not start biometric setup. Please try again." },
      { status: 500 },
    );
  }
}
