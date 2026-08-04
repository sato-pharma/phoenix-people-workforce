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
    // `?limit=` (present but empty) parses to 0, which is finite — so the naive check accepted it
    // and the service clamped it to 1, silently returning a single match for a search the rep
    // expected 30 results from. Anything not a positive number falls back to the default.
    const limitParam = url.searchParams.get("limit");
    const limitRaw = Number(limitParam);
    const limit = limitParam !== null && Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 30;
    const hits = await searchDirectOrderPharmacyDirectory(access, { query, distributorCode, limit });
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
