import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { searchDistributorCustomers } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Type-ahead search over a distributor's own customer list, for the new-pharmacy picker.
 *
 * Read-only, so no CSRF token — but NOT unscoped: `searchDistributorCustomers` bounds every
 * result to the caller's own areas, so this cannot be used to enumerate another region's
 * customers. The scope decision lives in the service, never here.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const customers = await searchDistributorCustomers(access, {
      distributorCode: url.searchParams.get("distributor") ?? "",
      regionCode: url.searchParams.get("region"),
      areaCode: url.searchParams.get("area"),
      query: url.searchParams.get("q"),
    });
    return NextResponse.json({ success: true, customers });
  } catch (error) {
    const apiError = toApiError(error, "Could not search the distributor's customers.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
