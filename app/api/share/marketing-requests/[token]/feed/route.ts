import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  buildMarketingReportBundleCsv,
  resolveMarketingReportShareLink,
} from "@/lib/marketing-requests/report-share-links";
import { systemDeployment } from "@/config/system-settings";
import { assertShareLinkRate, shareLinkRateRefusal } from "@/lib/share-links/token-hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * CSV bundle for the owner's live Marketing Request Google Sheet (owner request, 2026-08-05).
 *
 * UNAUTHENTICATED BY DESIGN, and that is the whole risk: an Apps Script running on a timer cannot
 * log in or type a passcode, so the token in the URL is the only credential. Everything that makes
 * that survivable lives in resolveMarketingReportShareLink — existence, revocation, expiry and the
 * creator-frozen scope are all checked there before a single row is read.
 *
 * The intended handling is that this URL lives inside a PRIVATE sheet's script and is never given
 * to a person; the sheet's own Google sharing is then the access control.
 *
 * Every response is no-store and noindex: a cached or crawled copy of this data would outlive the
 * revocation switch, which would defeat the point of having one.
 */
// `request` is read only for the caller's address, to meter it: the response depends only on the
// token in the path and the configured public URL. Nothing the caller sends may influence what it serves.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Limited per address and per link before the token is looked up, far above real use
  // (`@/lib/share-links/token-hash`). A refusal serves nothing and says nothing about the token.
  try {
    await assertShareLinkRate(request, token, { addressLimit: 1200, linkLimit: 600, scope: "marketing_share_feed" });
  } catch (limitError) {
    return shareLinkRateRefusal(limitError, "text");
  }
  try {
    const resolved = await resolveMarketingReportShareLink({ surface: "feed", token });

    const csv = buildMarketingReportBundleCsv({
      allowFiles: resolved.allowFiles,
      // The CONFIGURED public URL, never the request's own origin.
      //
      // This first shipped as `new URL(request.url).origin`, which behind Railway's proxy is the
      // container's internal bind address: every photo link in the owner's sheet came out as
      // https://0.0.0.0:8080/… and opened nothing. Reading x-forwarded-host instead would fix the
      // address and introduce a worse problem — a caller-controlled header deciding where the
      // sheet's links point, which is a link-poisoning primitive aimed at the one person who
      // trusts this report most.
      //
      // There is exactly one consumer, the owner's Google Sheet, and it can only ever reach the
      // public domain. A constant is both correct and unspoofable.
      baseUrl: systemDeployment.productionUrl,
      requests: resolved.requests,
      scope: resolved.scope,
      token,
    });

    return new NextResponse(csv, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Disposition": 'inline; filename="marketing-requests.csv"',
        "Content-Type": "text/csv; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
      status: 200,
    });
  } catch (error) {
    const apiError = toApiError(error, "This link is not available.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    // Deliberately terse: a probing caller learns whether a token is live, never anything about
    // the data behind it.
    return new NextResponse(apiError.message, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" },
      status,
    });
  }
}
