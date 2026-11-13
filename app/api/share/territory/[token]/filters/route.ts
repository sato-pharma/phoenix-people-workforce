import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { loadTerritoryPreviewFilters } from "@/lib/territory-management/preview-links";
import { assertShareLinkRate, shareLinkRateRefusal } from "@/lib/share-links/token-hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The regions and areas a preview link may show (owner request, 2026-08-14).
 *
 * UNAUTHENTICATED BY DESIGN, and unlike the Direct Orders live link there is no passcode either —
 * the owner asked for plain open access. The token in the URL is therefore the entire credential,
 * and everything that makes that survivable lives in loadTerritoryPreviewFilters: existence,
 * revocation, expiry and the creator-frozen area list are all settled there before a row is read.
 *
 * No line is returned. The link is pinned to one internally, but the viewer is not told which.
 *
 * no-store and noindex on every response, including the error: a cached or crawled copy would
 * outlive the expiry and the revoke switch, which are the only two controls this design has left.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Limited per address and per link before the token is looked up, far above real use
  // (`@/lib/share-links/token-hash`). A refusal serves nothing and says nothing about the token.
  try {
    await assertShareLinkRate(request, token, { addressLimit: 300, linkLimit: 600, scope: "territory_preview" });
  } catch (limitError) {
    return shareLinkRateRefusal(limitError, "json");
  }
  try {
    const filters = await loadTerritoryPreviewFilters(token);
    return NextResponse.json(
      { success: true, ...filters },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
        },
      },
    );
  } catch (error) {
    const apiError = toApiError(error, "This link is not available.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    // Deliberately terse: a probing caller learns whether a token is live, never anything about the
    // geography behind it.
    return NextResponse.json(
      { success: false, message: apiError.message },
      {
        status,
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
        },
      },
    );
  }
}
