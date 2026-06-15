import { NextResponse, type NextRequest } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { phoenixSessionCookieName, verifySessionToken } from "@/lib/auth/session-token";
import { recordPageView } from "@/lib/activity/service";

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
    for (const event of events) {
      const path = typeof event?.path === "string" ? event.path : "";
      if (!path) continue;
      await recordPageView({
        loginId: access.loginId ?? null,
        hrId: access.hrId ?? null,
        sessionId,
        role: access.role ?? null,
        path,
        durationMs: Number(event.durationMs) || 0,
        enteredAtIso: typeof event.enteredAt === "string" ? event.enteredAt : null,
        userAgent,
      });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[activity] track endpoint error", error);
    return new NextResponse(null, { status: 204 });
  }
}
