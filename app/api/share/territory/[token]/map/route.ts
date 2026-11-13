import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { loadTerritoryPreviewArea } from "@/lib/territory-management/preview-links";
import { assertShareLinkRate, shareLinkRateRefusal } from "@/lib/share-links/token-hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One area's brick pins for a preview link (owner request, 2026-08-14).
 *
 * UNAUTHENTICATED BY DESIGN and passcode-free, exactly like the filters route. The `areaCode` from
 * the query string is NEVER trusted: loadTerritoryPreviewArea intersects it against the link's
 * frozen area list before reading anything, so a hand-typed code for a neighbouring territory
 * answers "not found" instead of serving it.
 *
 * The response carries pins and unlocated brick names only. The residence recommendation, the
 * mis-assignment findings and the route/span/gap figures are projected out in the domain, not
 * hidden in the UI — hiding them client-side would still have shipped them in this JSON.
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
    const areaCode = new URL(request.url).searchParams.get("areaCode") ?? "";
    const area = await loadTerritoryPreviewArea(token, areaCode);
    return NextResponse.json(
      { success: true, ...area },
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
