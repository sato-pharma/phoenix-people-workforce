import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  listOffsetCandidates,
  recordMarketingRequestOffset,
  removeMarketingRequestOffset,
} from "@/lib/direct-orders/marketing-offset-service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const apiError = toApiError(error, "Settling against a direct order failed.");
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

/** The approved direct orders that still owe something — what the settle control offers. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const orders = await listOffsetCandidates(access);
    return NextResponse.json({ orders });
  } catch (error) {
    return failure(error);
  }
}

/** Settle a marketing request against a direct order: no cash moves, the order's debt falls. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      amount?: unknown;
      directOrderId?: unknown;
      note?: unknown;
      requestId?: unknown;
    };
    const result = await recordMarketingRequestOffset(access, {
      amount: Number(body.amount),
      directOrderId: String(body.directOrderId ?? ""),
      note: typeof body.note === "string" ? body.note : null,
      requestId: String(body.requestId ?? ""),
    });
    return NextResponse.json(result);
  } catch (error) {
    return failure(error);
  }
}

/** Undo a settlement; the debt goes back on the order. */
export async function DELETE(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { requestId?: unknown };
    const result = await removeMarketingRequestOffset(access, { requestId: String(body.requestId ?? "") });
    return NextResponse.json(result);
  } catch (error) {
    return failure(error);
  }
}
