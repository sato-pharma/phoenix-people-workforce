import { NextResponse } from "next/server";

import { verifyPasswordResetCode } from "@/lib/auth/password-setup";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { clientAddress } from "@/lib/security/client-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requestIp(request: Request): string | null {
  return clientAddress(request);
}

// One generic failure for EVERY reason a code does not verify — unknown account, wrong code,
// expired, locked, or a server error — so nothing distinguishes them to a caller guessing codes.
// A fresh response per call: a NextResponse body may be read only once.
function invalidCodeResponse() {
  return NextResponse.json(
    { error: "invalid_code", message: "That code is invalid or has expired. Request a new one." },
    { status: 400 },
  );
}

// Check a 6-digit code typed on /password-reset. On success it returns a short-lived one-time token
// the client uses to open the existing /password-setup/[token] screen and set the new password.
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { code?: string; identifier?: string };
  const identifier = String(payload.identifier ?? "").trim();
  const code = String(payload.code ?? "").trim();

  if (!identifier || !code) {
    return invalidCodeResponse();
  }

  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: 20,
      scope: "auth:password_reset_code_verify_ip",
      windowMs: 15 * 60 * 1000,
    });
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: identifier, request }),
      limit: 10,
      scope: "auth:password_reset_code_verify_id",
      windowMs: 15 * 60 * 1000,
    });
  } catch (error) {
    if (!isApiRateLimitError(error)) throw error;
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many attempts. Please wait a little and try again.",
        retryAfterSeconds: error.retryAfterSeconds,
      },
      { status: 429 },
    );
  }

  try {
    const { token } = await verifyPasswordResetCode({ code, identifier, requestIp: requestIp(request) });
    return NextResponse.json({ ok: true, token });
  } catch {
    return invalidCodeResponse();
  }
}
