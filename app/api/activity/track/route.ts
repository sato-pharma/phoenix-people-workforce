import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { phoenixSessionCookieName, verifySessionToken } from "@/lib/auth/session-token";
import { recordPageView } from "@/lib/activity/service";
import { logWarning } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EVENTS_PER_REQUEST = 25;

type RawEvent = {
  path?: unknown;
  durationMs?: unknown;
  enteredAt?: unknown;
};

function extractEvents(body: unknown): RawEvent[] {
  if (Array.isArray(body)) return body as RawEvent[];
  if (body && typeof body === "object") {
    const maybe = (body as { events?: unknown }).events;
    if (Array.isArray(maybe)) return maybe as RawEvent[];
    return [body as RawEvent];
  }
  return [];
}

// Lightweight, fire-and-forget ingest for in-app navigation/dwell events. The
// caller's identity is taken from the verified session cookie — NEVER from the
// request body — so a user can only ever record their own activity. Always
// returns 204 (even on bad input) so the client beacon never sees an error.
export async function POST(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return new NextResponse(null, { status: 204 });
    }
    // Only a real signed-in session is recorded. A local preview — the dev-auth cookie or the
    // x-phoenix-* headers, both source "dev-header" — runs against the PRODUCTION database that
    // .env.local points at, so recording it filed invented page views under real people's names:
    // on 2026-09-21 one preview left 433 rows showing a District Manager using the portal as a
    // Medical Rep, which the adoption and error-monitor readers then report as his own activity.
    if (access.source !== "session") {
      return new NextResponse(null, { status: 204 });
    }

    const token = request.cookies.get(phoenixSessionCookieName)?.value;
    const sessionId = verifySessionToken(token)?.sid ?? null;
    const userAgent = request.headers.get("user-agent");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new NextResponse(null, { status: 204 });
    }

    const events = extractEvents(body).slice(0, MAX_EVENTS_PER_REQUEST);
    // Each recordPageView is an independent insert with its own internal error handling
    // (never throws) — running the batch in parallel instead of one at a time is what keeps
    // this "fire-and-forget ingest" endpoint fast under a full 25-event batch.
    await Promise.all(
      events
        .filter((event) => typeof event?.path === "string" && event.path)
        .map((event) =>
          recordPageView({
            loginId: access.loginId ?? null,
            hrId: access.hrId ?? null,
            sessionId,
            role: access.role ?? null,
            path: event.path as string,
            durationMs: Number(event.durationMs) || 0,
            enteredAtIso: typeof event.enteredAt === "string" ? event.enteredAt : null,
            userAgent,
          }),
        ),
    );

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    // A test account's refusal is not a fault, and this is a BEACON: every page view by a TEST-…
    // login hit the guard in resolveAccessContext and logged a full ApiError stack at error level,
    // 131 lines in 40 hours (measured 02 Oct 2026) — one of the three signals that made 92% of this
    // app's error channel not-errors. Nothing was ever wrong: the endpoint already returns 204
    // either way, because a dropped page-view beacon is not worth telling a browser about.
    if (isForbiddenError(error)) return new NextResponse(null, { status: 204 });
    // Anything else is a real fault and stays visible — at WARNING, because a lost page-view
    // measurement is still not an incident.
    logWarning("[activity] track endpoint error", {
      labels: { event: "activity_track_failed", route: "/api/activity/track" },
      error,
    });
    return new NextResponse(null, { status: 204 });
  }
}
