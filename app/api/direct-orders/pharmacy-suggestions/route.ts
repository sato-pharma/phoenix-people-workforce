import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { suggestDirectOrderPharmacies } from "@/lib/direct-orders/pharmacy-validation";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Did you mean…" for a claimed pharmacy name (spec B4). Read-only. Shown to the rep before they
// may claim a pharmacy is new, and to the Super Admin on the validation desk — same call, so both
// are judging the same candidates.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "";
    const rows = await suggestDirectOrderPharmacies(access, { name, limit: 5 });
    return NextResponse.json({ rows, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load suggestions.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
