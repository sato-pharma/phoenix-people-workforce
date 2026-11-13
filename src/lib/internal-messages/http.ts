import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { ApiRateLimitError } from "@/lib/security/api-rate-limit";

/** True when the caller has no session: the route answers 401 before any permission is read. */
export function isSignedOut(access: AccessContext): boolean {
  return access.source === "guest" || (!access.loginId && !access.hrId);
}

/**
 * The one error answer for the internal-message routes: a signed-out caller 401, a role without
 * `internal_messages` 403, a sender past the limit 429 with Retry-After, anything else 400.
 */
export function internalMessageError(error: unknown, code: string, fallback: string) {
  if (error instanceof ApiRateLimitError) {
    return NextResponse.json(
      {
        error: code,
        message: "You have sent too many messages. Please wait and try again.",
        retryAfterSeconds: error.retryAfterSeconds,
      },
      { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
    );
  }
  const message = clientSafeErrorMessage(error, fallback);
  const status = message.startsWith("Forbidden:")
    ? 403
    : message.toLowerCase().includes("authentication is required")
      ? 401
      : 400;
  return NextResponse.json({ error: code, message }, { status });
}

export function internalMessageSignedOut(code: string) {
  return NextResponse.json({ error: code, message: "Authentication is required." }, { status: 401 });
}
