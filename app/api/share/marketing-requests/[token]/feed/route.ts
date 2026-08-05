import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  buildMarketingReportBundleCsv,
  resolveMarketingReportShareLink,
} from "@/lib/marketing-requests/report-share-links";
import { systemDeployment } from "@/config/system-settings";

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
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const resolved = await resolveMarketingReportShareLink({ surface: "feed", token });

    // File links must be absolute — the sheet renders them as HYPERLINK targets, and a relative
    // path there resolves against docs.google.com. Prefer the request's own origin so a preview
    // deployment links to itself, falling back to the production domain.
    const origin = (() => {
      try {
        return new URL(request.url).origin;
      } catch {
        return systemDeployment.productionUrl;
      }
    })();

    const csv = buildMarketingReportBundleCsv({
      allowFiles: resolved.allowFiles,
      baseUrl: origin,
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
