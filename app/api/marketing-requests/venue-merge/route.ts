import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listMarketingVenueMergeCandidates, mergeMarketingVenue } from "@/lib/marketing-requests/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The venue list the merge picker chooses from. Gated by the same assertMarketingControlAccess as
 * the merge itself, so the two halves can never disagree about who is allowed to be here.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json({ venues: await listMarketingVenueMergeCandidates(access) });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the venue list.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message },
      { status },
    );
  }
}

/**
 * Fold a duplicate marketing venue into the one that survives.
 *
 * `mergeMarketingVenue` and the columns it writes shipped on 2026-08-23 (#2323) with nothing able
 * to call them: the service existed, the migration was applied to production, and the only way to
 * merge two venues was still a hand-written SQL statement. This route is the missing half.
 *
 * Identity is the caller's judgement — the service refuses only the structurally impossible (a
 * venue merged into itself, into a venue that is itself a merged duplicate, or twice) and never
 * guesses from a similar name. That is why `reason` is required rather than optional: it is the
 * only record of why a human decided two rows were one physical place.
 *
 * Zero authorization logic here: mergeMarketingVenue calls assertMarketingControlAccess, which
 * admits system scope, SFE Manager and Super Admin, and writes a REQUIRED audit row on success.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      loserId?: string;
      reason?: string;
      survivorId?: string;
    };

    const result = await mergeMarketingVenue(access, {
      loserId: String(body.loserId ?? ""),
      reason: String(body.reason ?? ""),
      survivorId: String(body.survivorId ?? ""),
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not merge the venues.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
