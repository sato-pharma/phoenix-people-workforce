/**
 * Phoenix CRM — the answer a route gives when a request is refused or fails.
 *
 * A refusal the module wrote (ApiError: the territory is outside the viewer's scope, the plan moved on,
 * the photo expired) reaches the screen as written, because it is a sentence for the person who
 * pressed the button. Anything else is logged and answered with the route's own sentence, so a
 * database or storage message never reaches a phone.
 */

import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { isSignedOutRefusal } from "@/lib/auth/signed-out-refusal";
import { ApiError, toApiError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export function phoenixCrmFailure(error: unknown, fallback: string): NextResponse {
  // A per-person limit (toApiError does not know it, and would answer 500).
  if (isApiRateLimitError(error)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests in the last hour. Wait a few minutes and try again.", success: false },
      { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
    );
  }
  // 🔴 NOBODY IS SIGNED IN — the session ended (its absolute expiry, mid-plan) or never existed. A 401, which
  // the client turns into "You are signed out. Sign in again", never a 403 that reads as a permissions
  // problem (a district manager, 24 Oct 2026 02:36 Cairo: refused 24 s after his session reached its expiry).
  if (isSignedOutRefusal(error)) {
    return NextResponse.json(
      { error: "signed_out", message: "Your sign-in has ended. Sign in again, then try once more.", success: false },
      { status: 401 },
    );
  }
  const apiError = toApiError(error, fallback);
  const status = isForbiddenError(error) ? 403 : apiError.status;
  const written = error instanceof ApiError || status < 500;
  if (!written) {
    logError("Phoenix CRM request failed", { labels: { event: "phoenix_crm_request_failed" }, error });
  }
  return NextResponse.json(
    { error: status === 403 ? "forbidden" : apiError.code, message: written ? apiError.message : fallback, success: false },
    { status },
  );
}

/** The query string of a GET. */
export function searchOf(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}
