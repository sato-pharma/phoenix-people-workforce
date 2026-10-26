import { NextResponse } from "next/server";

import { getRequestIp } from "@/lib/auth/audit";
import { readIpBlock } from "@/lib/auth/ip-blocklist";
import { buildAuthenticationOptions, resolveRelyingParty } from "@/lib/auth/webauthn";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { rejectUntrustedForwardedOrigin } from "@/lib/security/origins";
import { describeUnexpectedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 1 of signing in: issue a challenge. Public by necessity — the caller has not proved
// anything yet.
//
// This endpoint deliberately reveals NOTHING about who has biometrics enrolled. It returns the same
// challenge shape to everyone, carries no allowCredentials list, and takes no login ID, so it cannot
// be used to enumerate accounts. The browser matches the challenge to a passkey locally.
export async function POST(request: Request) {
  try {
    const originRejection = rejectUntrustedForwardedOrigin(request);
    if (originRejection) {
      return NextResponse.json(
        { error: "invalid_origin", message: "Request origin is not trusted." },
        { status: 400 },
      );
    }

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

    // Same generic response as the rate limit above, so a blocked IP learns nothing about why.
    // Fail-closed, as at the password door: an unreadable blocklist refuses the sign-in (point 15),
    // as "temporarily unavailable" — it is an outage, not a block (risk review, 26 Oct).
    const blocklist = await readIpBlock(getRequestIp(request));
    if (blocklist === "unreadable") {
      return NextResponse.json(
        { error: "sign_in_unavailable", message: "Sign-in is temporarily unavailable. Please try again in a few minutes." },
        { status: 503 },
      );
    }
    if (blocklist === "blocked") {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many sign-in attempts. Please try again later." },
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

    return NextResponse.json({ options: await buildAuthenticationOptions(relyingParty) });
  } catch (error) {
    console.error(
      "[auth/biometric/login/options] failed",
      describeUnexpectedError(error),
    );
    return NextResponse.json(
      { error: "options_failed", message: "Could not start biometric sign-in." },
      { status: 500 },
    );
  }
}
