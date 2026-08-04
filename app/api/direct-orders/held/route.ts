import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listHeldDirectOrders } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The System Admin's Held Desk (spec C3 — docs/specs/direct-orders-v2.md): every direct order
// parked outside the approval flow because its pharmacy is not in the master database.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const rows = await listHeldDirectOrders(access);
    return NextResponse.json({ rows, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load held direct orders.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
