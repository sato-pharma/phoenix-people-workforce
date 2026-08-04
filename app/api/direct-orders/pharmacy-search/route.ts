import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { searchDirectOrderPharmacyDirectory } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Type-ahead behind the submit form's pharmacy combo box (spec B1/B2 —
// docs/specs/direct-orders-v2.md). Read-only; the service enforces both the
// `direct_orders:read` permission and the caller's area scope.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const distributorCode = url.searchParams.get("distributor");
    const limitRaw = Number(url.searchParams.get("limit") ?? "30");
    const hits = await searchDirectOrderPharmacyDirectory(access, {
      query,
      distributorCode,
      limit: Number.isFinite(limitRaw) ? limitRaw : 30,
    });
    return NextResponse.json({ hits, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not search the pharmacy directory.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
