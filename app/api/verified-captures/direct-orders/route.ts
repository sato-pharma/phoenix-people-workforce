import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listVerifiedDirectOrderCaptures } from "@/lib/verified-captures/direct-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every verified direct-order pharmacy captured in the field or by invoice — photos, location and who
// captured it. Access is enforced inside the service (Super Admin only); the route is transport.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json({ rows: await listVerifiedDirectOrderCaptures(access) });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the verified direct-order captures.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message },
      { status },
    );
  }
}
