import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { VisualAidInputError, VisualAidNotFoundError } from "@/lib/visual-aids/rules";

/**
 * One error mapping for every Visual Aids route, so the page reads the same status for the same
 * cause whichever button was pressed: a refused permission is 403, a mistake in what was typed or
 * uploaded is 400 with a sentence for the person who did it, and an aid the viewer may not open is
 * 404 — the same answer as an id that does not exist, so another line's library is never confirmed.
 */
export function visualAidsErrorResponse(error: unknown, fallback: string): NextResponse {
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  if (error instanceof VisualAidInputError) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }
  if (error instanceof VisualAidNotFoundError) {
    return NextResponse.json({ message: error.message }, { status: 404 });
  }
  return NextResponse.json({ message: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}
