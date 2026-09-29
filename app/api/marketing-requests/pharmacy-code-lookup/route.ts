import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  getMarketingPharmacyCodeReferenceStatus,
  searchMarketingPharmacyCodeSuggestions,
} from "@/lib/marketing-requests/service";

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
      return NextResponse.json({ matchCount: 0, status: "not_found", suggestions: [], tracked: false });
    }

    const result = await getMarketingPharmacyCodeReferenceStatus(
      { distributorId, pharmacyCode: code },
      access,
    );

    // The ranked candidates, added 2026-09-29. Ranked by where the rep just stood and NEVER
    // filtered by it (owner ruling) — the place decides the ORDER, never the membership.
    //
    // Deliberately additive and deliberately non-fatal: the existing `tracked` answer is what the
    // page has always needed, and a suggestion list that fails to build must never take that with
    // it. A caller that sends no area still gets the full list, just unranked.
    let suggestions: Awaited<ReturnType<typeof searchMarketingPharmacyCodeSuggestions>>["suggestions"] = [];
    try {
      ({ suggestions } = await searchMarketingPharmacyCodeSuggestions(
        {
          areaName: url.searchParams.get("area"),
          distributorId,
          governorateName: url.searchParams.get("governorate"),
          pharmacyCode: code,
        },
        access,
      ));
    } catch {
      suggestions = [];
    }

    return NextResponse.json({ ...result, suggestions });
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
