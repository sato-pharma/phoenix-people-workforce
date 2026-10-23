import { NextResponse } from "next/server";

import { requestPasswordResetCode } from "@/lib/auth/password-setup";
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

// Email a one-time 6-digit code to the Sato mailbox for whatever identifier (HR_ID, login ID or
// work email) a person types on /password-reset. ALWAYS answers the same "if that account exists,
// a code was sent" — an unknown identifier, an inactive account, a missing mailbox and a successful
// send are indistinguishable, so this reveals nothing about who has an account. Only a rate limit
// changes the response.
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { identifier?: string };
  const identifier = String(payload.identifier ?? "").trim();

  if (!identifier) {
    return NextResponse.json(
      { error: "missing_identifier", message: "Enter your HR ID or Sato email." },
      { status: 400 },
    );
  }

  try {
    // Two buckets: one keyed on the IP (a flood from one source), one on the identifier itself (many
    // sources hammering one account). Either tripping returns 429, never a hint about the account.
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: 12,
      scope: "auth:password_reset_code_request_ip",
      windowMs: 15 * 60 * 1000,
    });
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: identifier, request }),
      limit: 5,
      scope: "auth:password_reset_code_request_id",
      windowMs: 15 * 60 * 1000,
    });
  } catch (error) {
    if (!isApiRateLimitError(error)) throw error;
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many requests. Please wait a little and try again.",
        retryAfterSeconds: error.retryAfterSeconds,
      },
      { status: 429 },
    );
  }

  // Swallow everything the resolve/send path can throw: surfacing a server error ONLY for an
  // existing account (the non-existing case returns early with no error) would itself leak which
  // identifiers are real. A rare failure just means no code arrived, and the person re-requests.
  try {
    await requestPasswordResetCode({ identifier, requestIp: requestIp(request) });
  } catch {
    // intentionally ignored — see above
  }

  return NextResponse.json({
    ok: true,
    message: "If that account exists, a 6-digit code has been sent to its Sato email.",
  });
}
