import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseExpectedDirectOrderCollection } from "@/lib/direct-orders/collection-rules";
import { recordDirectOrderCollection } from "@/lib/direct-orders/service";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the collection control sends (REC-060): the new total and date (each null to clear), and the
 * total and date the screen LOADED (each null when nothing was recorded). Every field is optional, so an
 * older tab's body without the expectation, and the empty body a refused role sends, still reach their
 * own answer. parseExpectedDirectOrderCollection keeps judging the expectation's VALUE, with its own
 * sentence; a key the body leaves out stays out, so "sent neither" still means "an older tab".
 */
const CollectionBodySchema = z.object({
  paidAmount: z.number().nullable().optional(),
  paymentDate: z.string().nullable().optional(),
  expectedPaidAmount: z.number().nullable().optional(),
  expectedPaymentDate: z.string().nullable().optional(),
});

/**
 * Record the money collected against an approved direct order — or clear it with paidAmount: null.
 *
 * Separate from the sales-month route on purpose: approval, booking a month, and collecting the
 * cash are three different events, and this one must never move which month the sales landed in.
 * `remainingAmount` is derived in the service from the order value and is deliberately NOT
 * accepted from the client. Authorization lives in the service (Finance / Super Admin only) —
 * this route never decides which role may call it; it only refuses a signed-out caller before it
 * reads the body (REC-080).
 *
 * `expectedPaidAmount` / `expectedPaymentDate` are the collection the screen LOADED. The write is
 * compared against them, so a save from a page opened before someone else's save answers 409
 * instead of replacing it. Both absent (an older open tab) falls back to the server's own read.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    const { id } = await context.params;
    const parsed = await parseJsonBody(request, CollectionBodySchema, { fallback: {} });
    if (!parsed.ok) throw validationError(parsed.message);
    const body = parsed.data;
    const expected = parseExpectedDirectOrderCollection(body);
    if (!expected.ok) throw validationError(expected.message);
    const updated = await recordDirectOrderCollection(access, {
      requestId: id,
      paidAmount: body.paidAmount ?? null,
      paymentDate: body.paymentDate ?? null,
      expected: expected.expected,
    });
    return NextResponse.json({
      success: true,
      paidAmount: updated.paidAmount,
      paymentDate: updated.paymentDate,
      remainingAmount: updated.remainingAmount,
    });
  } catch (error) {
    const apiError = toApiError(error, "Could not record the collection.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
