import { NextResponse, type NextRequest } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  SCREEN_BODY_MAX_BYTES,
  SCREEN_RATE_LIMIT_PER_HOUR,
  parseScreenReport,
  screenBodyTooLarge,
} from "@/lib/error-monitor/screen-intake";
import { countRecentUserErrorScreens, screenOwnerFor, storeUserErrorScreen } from "@/lib/error-monitor/user-error-screens";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { getDeployRevisionTag } from "@/lib/observability/deploy-identity";
import { logWarning } from "@/lib/observability/log";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/errors/screen — the picture of an error or a block a person just met (owner, 23 Oct 2026;
 * docs/system-audit.md, "What the person saw"). Sent by src/lib/error-monitor/screen-capture.ts.
 *
 *   · SIGNED-IN ONLY. A guest gets 401 and nothing is stored: a picture with nobody behind it cannot
 *     be put in front of the Super Admin as "what this person saw".
 *   · Same-origin only, and a body over 1.7 MB is refused before it is read (413).
 *   · Every field is checked (screen-intake.ts): the kind, a REAL JPEG or WebP of at most 1.2 MB
 *     decoded, capped strings, paths without their query.
 *   · At most 40 pictures a person an hour, counted from the table itself (429).
 *   · A test account's picture is filed under its own login with is_test set, never under the
 *     employee it mirrors (user-error-screens.ts).
 *   · Answers 204 when stored. Never logs the picture.
 */
export async function POST(request: NextRequest) {
  const csrfError = assertSameOriginMutation(request);
  if (csrfError) return csrfError;
  if (screenBodyTooLarge(request.headers.get("content-length"))) {
    return NextResponse.json({ error: "too_large", message: "The picture is larger than 1.2 MB." }, { status: 413 });
  }

  try {
    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;

    const raw = await request.text();
    // A body with no (or a false) Content-Length is capped on the read as well.
    if (raw.length > SCREEN_BODY_MAX_BYTES) {
      return NextResponse.json({ error: "too_large", message: "The picture is larger than 1.2 MB." }, { status: 413 });
    }
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "invalid_request", message: "The request body is not valid JSON." }, { status: 400 });
    }
    const parsed = parseScreenReport(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: "invalid_request", message: parsed.message }, { status: 400 });
    }

    const owner = screenOwnerFor(access);
    if (!owner.hrId && !owner.loginId) {
      return NextResponse.json({ error: "invalid_request", message: "Your session names no person to file this under." }, { status: 400 });
    }

    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await countRecentUserErrorScreens(owner, sinceIso);
    if (recent >= SCREEN_RATE_LIMIT_PER_HOUR) {
      return NextResponse.json({ error: "rate_limited", message: "Too many pictures this hour." }, { headers: { "Retry-After": "3600" }, status: 429 });
    }

    await storeUserErrorScreen({ owner, report: parsed.report, release: getDeployRevisionTag() });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (isForbiddenError(error)) {
      // A read-only View as Seat refuses every write, this one included.
      return NextResponse.json({ error: "forbidden", message: "This session may not store a picture." }, { status: 403 });
    }
    // The message only — never the body, which is the picture.
    logWarning("Error screenshot could not be stored", {
      labels: { event: "user_error_screen_store_failed" },
      context: { reason: describeThrown(error).slice(0, 300) },
    });
    return NextResponse.json({ error: "unavailable", message: "The picture could not be stored." }, { status: 503 });
  }
}
