import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { MarketAwarenessError } from "@/lib/market-awareness/service";

/**
 * One error shape for every Market Awareness route.
 *
 * `MarketAwarenessError` carries its own status because the domain knows the difference between "you
 * may not" (403) and "that does not exist" (404) and "you asked for something impossible" (400).
 * Flattening all three to 500 is how a permission refusal reads to a user as the system being
 * broken.
 *
 * A probe cannot trust the status code alone on this app — a POST to any `/api/**` path answers 403
 * even when the route does not exist — so the `error` slug is what a caller should branch on.
 */
export function marketAwarenessErrorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof MarketAwarenessError) {
    return NextResponse.json(
      {
        error: error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : "invalid_request",
        message: error.message,
        success: false,
      },
      { status: error.status },
    );
  }

  const apiError = toApiError(error, fallbackMessage);
  const status = isForbiddenError(error) ? 403 : apiError.status;
  return NextResponse.json(
    {
      error: status === 403 ? "forbidden" : apiError.code,
      message: apiError.message,
      success: false,
    },
    { status },
  );
}
