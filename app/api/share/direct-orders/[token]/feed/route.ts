import { NextResponse } from "next/server";

import {
  buildDirectOrderReportBundleCsv,
  buildDirectOrderReportCsv,
  resolveDirectOrderReportShareLink,
} from "@/lib/direct-orders/report-share-links";
import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { systemDeployment } from "@/config/system-settings";
import { assertShareLinkRate, shareLinkRateRefusal } from "@/lib/share-links/token-hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * CSV feed for a Google Sheet's IMPORTDATA (owner request, 2026-08-05).
 *
 * UNAUTHENTICATED BY DESIGN, and that is the whole risk: a spreadsheet formula cannot log in or
 * type a passcode, so the token in the URL is the only credential. Everything that makes that
 * survivable lives in resolveDirectOrderReportShareLink — existence, revocation, expiry, and the
 * creator-frozen scope are all checked there before a single row is read.
 *
 * The intended handling is that this URL lives inside a private Google Sheet's formula and is
 * never given to a person; the SHEET's own Google sharing is then the access control. The human
 * surface (`/api/share/direct-orders/[token]/live`) is the one that demands a passcode.
 *
 * Every response is no-store and noindex: a cached or crawled copy of this data would outlive the
 * revocation switch, which would defeat the point of having one.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Limited per address and per link before the token is looked up, far above real use
  // (`@/lib/share-links/token-hash`). A refusal serves nothing and says nothing about the token.
  try {
    await assertShareLinkRate(request, token, { addressLimit: 1200, linkLimit: 600, scope: "direct_order_share_feed" });
  } catch (limitError) {
    return shareLinkRateRefusal(limitError, "text");
  }
  try {
    const resolved = await resolveDirectOrderReportShareLink({ token, surface: "feed" });
    // ?bundle=1 returns the cover figures, the by-status breakdown and the order table in ONE
    // response, so the Sheet's three tabs are always the same snapshot. The bare form stays a plain
    // single-table CSV, because an IMPORTDATA formula cannot skip section markers.
    const wantsBundle = new URL(request.url).searchParams.get("bundle") === "1";
    const csv = wantsBundle
      // The CONFIGURED public URL, never the request's own origin. Behind Railway's proxy that
      // origin is the container's internal bind address, which is how the marketing sheet ended up
      // rendering every photo link as https://0.0.0.0:8080/… and opening nothing.
      ? buildDirectOrderReportBundleCsv(resolved.rows, resolved.scope, {
        allowFiles: resolved.allowFiles,
        baseUrl: systemDeployment.productionUrl,
        token,
      })
      : buildDirectOrderReportCsv(resolved.rows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Content-Disposition": 'inline; filename="direct-orders.csv"',
      },
    });
  } catch (error) {
    const apiError = toApiError(error, "This link is not available.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    // Deliberately terse: a probing caller learns whether a token is live, never anything about
    // the data behind it.
    return new NextResponse(apiError.message, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" },
    });
  }
}
