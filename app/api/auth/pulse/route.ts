import { NextResponse } from "next/server";

import { emptyBadgeCounts, loadBadgeCounts } from "@/lib/approvals-hub/badge-counts-payload";
import type { AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { applySeatView } from "@/lib/auth/seat-view";
import { phoenixSeatViewCookieName } from "@/lib/auth/seat-view-constants";
import { getCookieValue } from "@/lib/auth/session";
import { heartbeatResponse, heartbeatSessionToken, runSessionHeartbeat } from "@/lib/auth/session-heartbeat";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { listInAppNoticeBundleForViewer } from "@/lib/notifications/in-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE SESSION PULSE — one request where an open tab used to send three.
 *
 * A visible admin page polled three endpoints on their own clocks: the sidebar badge counts every
 * 30 s, the notification bell every 60 s, and the session heartbeat on activity with a 60 s floor.
 * Each one resolves the viewer, and resolving the viewer is one `phx_auth_session_bundle` call —
 * measured on production 23 Oct 2026 at 36,926 calls a day, 87 ms each, 8,124 s of database time,
 * the single heaviest function in the system. This route carries all three in ONE request, so a
 * visible tab pays TWO session reads a minute instead of four, with every number as fresh as before.
 *
 * It owns no logic of its own. The badges come from `loadBadgeCounts` (eleven domain reads, their
 * permission guards and the 20 s per-viewer memory) and the session from `runSessionHeartbeat` — the
 * same functions /api/approvals/badge-counts and /api/auth/heartbeat call, which both stay live and
 * unchanged for every other consumer.
 *
 * WHY TWO METHODS, AND WHY THE POST IS THE ONE THAT KEEPS THE SESSION ALIVE.
 *
 * GET resolves the viewer with `resolveAccessContext`, which may serve a RECENT COPY of the session
 * bundle (session-bundle-cache.ts). That is right for reads and wrong for a keep-alive: a copy
 * cannot confirm a session is still live, and it writes no new idle expiry. So the GET serves badges
 * and notices only, and the client sends it on the ticks where nothing needs refreshing.
 *
 * POST runs the heartbeat — the live session read, the idle refresh and the cookie rotation — and
 * then serves the same badges and notices off the session it just confirmed. It deliberately does
 * NOT call `resolveAccessContext`: that resolver applies the seat-view and test-account write
 * guards, which refuse every POST but the seat-view exit, so going through it would stop a View as
 * Seat and a test login from ever refreshing their session (the heartbeat has never gone through it
 * either). `runSessionHeartbeat` hands back the OWNER's own context, so the View as Seat is layered
 * on here with `applySeatView` — the same layering the API resolver does — and the counts and
 * notices a seat view sees are the seat's, never the Super Admin's.
 */

function flagged(request: Request, name: string): boolean {
  return new URL(request.url).searchParams.get(name) === "1";
}

/**
 * The badges, or the all-zero body when they could not be read at all — the same fallback
 * /api/approvals/badge-counts answers with, so one failed domain never blanks the sidebar and a
 * failure here never costs the caller its session fields.
 */
async function badgesFor(access: AccessContext, startedAt: number) {
  try {
    return await loadBadgeCounts(access, startedAt);
  } catch {
    return emptyBadgeCounts();
  }
}

/**
 * The newest notices for this viewer, in the shape the bell already reads — `{data, success}`, or
 * `{error, message}` when the read failed. Nested under `notices`, never the response status: the
 * same request carries the session fields the client signs out on, so a broken notification read
 * must not turn the whole pulse into a 500. It asks for the service's default count, which is what
 * the bell's own endpoint asks for.
 *
 * Since 1 Nov 2026 the same read also carries `unreadMessages` — the envelope's unread count — so
 * the messages menu no longer fetches /api/messages on every page view to draw its badge. Null when
 * the count could not be read (the bundle RPC is missing), and the menu then fetches once itself.
 */
async function noticesFor(access: AccessContext) {
  try {
    if (!access.loginId && !access.hrId) return { data: [], success: true, unreadMessages: null };
    const bundle = await listInAppNoticeBundleForViewer(access);
    return { data: bundle.notices, success: true, unreadMessages: bundle.unreadMessages };
  } catch (error) {
    console.error("/api/auth/pulse notices failed", error);
    return {
      error: "notification_load_failed",
      message: clientSafeErrorMessage(error, "Unable to load notifications."),
    };
  }
}

async function payloadFor(request: Request, access: AccessContext, startedAt: number) {
  const wantsBadges = flagged(request, "badges");
  const wantsNotices = flagged(request, "notices");
  const [badges, notices] = await Promise.all([
    wantsBadges ? badgesFor(access, startedAt) : Promise.resolve(null),
    wantsNotices ? noticesFor(access) : Promise.resolve(null),
  ]);
  const payload: Record<string, unknown> = {};
  if (badges) payload.badges = badges;
  if (notices) payload.notices = notices;
  return payload;
}

/**
 * The read-only tick: badges and notices with no session refresh. A failure to resolve the viewer at
 * all answers 200 with the quiet fallbacks rather than a status the client would read as a sign-out
 * — one body cannot carry two statuses, and the badge endpoint already answers an unresolvable
 * caller with zeros. The client learns a session has ended from the POST tick, which is the only one
 * that actually checks.
 */
export async function GET(request: Request) {
  const startedAt = Date.now();
  let access: AccessContext;
  try {
    access = await resolveAccessContext(request);
  } catch (error) {
    console.error("GET /api/auth/pulse could not resolve the viewer", error);
    const payload: Record<string, unknown> = { ok: true };
    if (flagged(request, "badges")) payload.badges = emptyBadgeCounts();
    if (flagged(request, "notices")) {
      payload.notices = {
        error: "notification_load_failed",
        message: "Unable to load notifications.",
      };
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    { ok: true, ...(await payloadFor(request, access, startedAt)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The heartbeat tick: the live session read first, and the badges and notices only if it confirmed a
 * session. A 429, 503 or 401 answers exactly what /api/auth/heartbeat answers, with the same cookies
 * and nothing else in the body — a tab that has been signed out or met an outage must read the same
 * thing it has always read.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const result = await runSessionHeartbeat(request);
  if (!result.access) return heartbeatResponse(result);

  const viewer =
    applySeatView(
      result.access,
      heartbeatSessionToken(request),
      getCookieValue(request.headers.get("cookie"), phoenixSeatViewCookieName),
    ) ?? result.access;

  return heartbeatResponse(result, await payloadFor(request, viewer, startedAt));
}
