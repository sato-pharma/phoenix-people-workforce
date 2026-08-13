import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listMyApprovedDirectOrderPharmacies } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "My pharmacies" — the ones this person has already put through successfully (owner, 2026-08-13).
//
// Distinct from GET /api/direct-orders/pharmacies, which lists everything they ever REGISTERED
// including records still awaiting review. This one lists what is safe to reuse in one click, and
// it exists to remove the reason duplicates are typed at all: every duplicate cluster in production
// is a rep re-entering a pharmacy they had already used, sometimes the same day.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const pharmacies = await listMyApprovedDirectOrderPharmacies(access);
    return NextResponse.json({ pharmacies, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load your pharmacies.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
