import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listDirectOrderCampaignOptions } from "@/lib/direct-orders/campaign-link";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The campaigns behind the submit form's "Came from a campaign" picker.
 *
 * Read-only, and the service is the boundary: it applies the same role rule as raising an order,
 * scopes to the requested line, and returns labels only — never campaign money. The `?line=` value
 * is the order's own product line, which the form already knows once a product is chosen.
 *
 * An unknown or missing line yields an empty list rather than an error: "no campaign matches" is a
 * normal state for this picker, and it must never be able to block a submission.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const line = url.searchParams.get("line");
    const options = await listDirectOrderCampaignOptions(access, line);
    return NextResponse.json({ options, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the campaign list.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
