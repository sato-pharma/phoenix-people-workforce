import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { getMarketingPharmacyCodeReferenceStatus } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Advisory, non-blocking lookup for the Customer Validation page. Given a marketing
 * distributor + a pharmacy code, reports whether that pair already exists in the Phoenix
 * reference database (fed from the sales module) so the rep can see whether sales for it
 * can be tracked. This never blocks submission, so any failure is reported as "unknown".
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const distributorId = (url.searchParams.get("distributorId") ?? "").trim();
    const code = (url.searchParams.get("code") ?? "").trim();

    if (!distributorId || !code) {
      return NextResponse.json({ matchCount: 0, status: "not_found", tracked: false });
    }

    const result = await getMarketingPharmacyCodeReferenceStatus(
      { distributorId, pharmacyCode: code },
      access,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }

    const apiError = toApiError(error, "Unable to check the pharmacy code.");
    return NextResponse.json(
      { error: apiError.code, message: apiError.message, matchCount: 0, status: "unknown", tracked: false },
      { status: apiError.status },
    );
  }
}
