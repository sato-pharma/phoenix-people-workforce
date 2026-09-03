import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listVenueContactOptions } from "@/lib/direct-orders/venue-contact-options";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The CRM contacts behind the venue form's "This venue is on the CRM as…" picker.
 *
 * Read-only, and the service is the boundary: it applies the same role rule as registering a venue
 * and resolves the caller's own scope — self UNION org subtree — so this route cannot hand back a
 * contact the caller could not already see. The scope is computed from the live AccessContext and
 * never from a query parameter, because a scope read off the URL is not a scope.
 *
 * `?search=` narrows by name, Arabic name, address or CRM region; `?limit=` caps the response and
 * the body's `truncated` flag says whether the cap bit. An empty list is a normal state and must
 * never block a registration — the link is optional by design.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const search = url.searchParams.get("search");
    const rawLimit = Number(url.searchParams.get("limit") ?? "");
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null;
    const result = await listVenueContactOptions(access, { search, limit });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load your CRM contacts.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
