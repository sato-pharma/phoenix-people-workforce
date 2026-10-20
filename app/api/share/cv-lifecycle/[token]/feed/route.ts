import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  cvLifecycleCsvFor,
  resolveCvLifecycleShareLink,
} from "@/lib/recruitment/cv-lifecycle-share-links";
import { fenceCvLifecycleFeed } from "@/lib/recruitment/workspace/fence";
import { systemDeployment } from "@/config/system-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * CSV bundle for the owner's live CV-lifecycle Google Sheet (owner request, 2026-09-04).
 *
 * UNAUTHENTICATED BY DESIGN, and that is the whole risk: an Apps Script running on a timer cannot
 * log in, so the token in the URL is the only credential. Everything that makes that survivable
 * lives in resolveCvLifecycleShareLink — existence, revocation and expiry are all checked there
 * before a single candidate row is read.
 *
 * The intended handling is that this URL lives inside a PRIVATE sheet's script and is never given
 * to a person; the sheet's own Google sharing is then the access control.
 *
 * Every response is no-store and noindex: a cached or crawled copy of a list of candidate names and
 * phone numbers would outlive the revocation switch, which would defeat the point of having one.
 */
// `_request` is deliberately unused: the response depends only on the token in the path and the
// configured public URL. Nothing the caller sends may influence what this route serves.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    // A link the Talent Acquisition seat made never carries an HR applicant (owner, 2026-10-20).
    const feed = await fenceCvLifecycleFeed(await resolveCvLifecycleShareLink(token));

    // The CONFIGURED public URL, never the request's own origin. Behind Railway's proxy the
    // request origin is the container's internal bind address, so every "Open in Phoenix" link
    // would come out as https://0.0.0.0:8080/… and open nothing; reading x-forwarded-host instead
    // would fix the address and hand a caller-controlled header the power to decide where the
    // owner's links point. There is exactly one consumer and it can only reach the public domain,
    // so a constant is both correct and unspoofable.
    const csv = cvLifecycleCsvFor(feed, systemDeployment.productionUrl);

    return new NextResponse(csv, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Disposition": 'inline; filename="cv-lifecycle.csv"',
        "Content-Type": "text/csv; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
      status: 200,
    });
  } catch (error) {
    const apiError = toApiError(error, "This link is not available.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    // Deliberately terse: a probing caller learns whether a token is live, never anything about
    // the candidates behind it.
    return new NextResponse(apiError.message, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" },
      status,
    });
  }
}
