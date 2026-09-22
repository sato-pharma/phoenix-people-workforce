import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

/**
 * The shared error shape for the record-conversation routes (direct orders + marketing requests).
 *
 * One exported helper, imported by both `[id]/conversation/route.ts` handlers, so the response
 * contract lives in one place rather than as a per-route inline `jsonError` (route-error-shape
 * ratchet, `tests/route-error-shape-ratchet.test.ts`). A refusal from the domain helper — a message
 * that leads with "Forbidden:" or an ApiError the auth layer marks forbidden — becomes a 403;
 * everything else is a 400. The body is `{ error, message, success:false }`; the client reads
 * `message`/`success` and the HTTP status, `errorCode` is for API consumers.
 */
export function jsonError(error: unknown, fallback: string, errorCode: string) {
  const message = clientSafeErrorMessage(error, fallback);
  const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
  return NextResponse.json(
    { error: forbidden ? "forbidden" : errorCode, message, success: false },
    { status: forbidden ? 403 : 400 },
  );
}
