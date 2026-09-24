import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listVerifiedMarketingCaptures } from "@/lib/verified-captures/marketing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every verified marketing customer's live capture — photos, location and who captured it. Access is
// enforced inside the service (Super Admin only); the route is transport, the service is the boundary.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json({ rows: await listVerifiedMarketingCaptures(access) });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the verified marketing captures.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message },
      { status },
    );
  }
}
