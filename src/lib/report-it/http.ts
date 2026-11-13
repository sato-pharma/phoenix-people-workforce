import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { ApiRateLimitError } from "@/lib/security/api-rate-limit";

/**
 * The one error answer for every Report It route. A refusal is never a 400: a missing permission
 * is 403, a signed-out caller 401, a sender past the limit 429, and a read that could not be
 * logged 503 — nothing was shown, and trying again is the right next step.
 */
export function reportItJsonError(error: unknown, fallback: string) {
  if (error instanceof ApiRateLimitError) {
    return NextResponse.json(
      { error: error.message, retryAfterSeconds: error.retryAfterSeconds },
      { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
    );
  }
  const message = clientSafeErrorMessage(error, fallback);
  if (message.startsWith("Forbidden:")) return NextResponse.json({ error: message }, { status: 403 });
  if (message.startsWith("Unavailable:")) return NextResponse.json({ error: message }, { status: 503 });
  if (message.toLowerCase().includes("authentication")) return NextResponse.json({ error: message }, { status: 401 });
  return NextResponse.json({ error: message }, { status: 400 });
}

export function reportItSignedOut() {
  return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
}
