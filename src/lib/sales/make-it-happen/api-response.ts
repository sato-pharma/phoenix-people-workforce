import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { MakeItHappenError } from "@/lib/sales/make-it-happen/plans";

/** One error shape for every Make It Happen route — the Market Awareness convention. */
export function makeItHappenErrorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof MakeItHappenError) {
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
