import { buildCalendarFeedForToken } from "@/lib/recruitment/interview-calendar-ics";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

const HOUR = 60 * 60 * 1000;

// The per-person .ics subscription feed. Reached by a bearer token, NOT a Phoenix sign-in — a
// calendar app (Outlook, Google, the phone) cannot sign in. The token resolves to one hr id and the
// feed carries only that person's own interviews, and only while that person still has an active
// login and is still employed (buildCalendarFeedForToken). An unknown or retired token, or one whose
// holder has left, returns a valid EMPTY calendar, never an error, so a stale subscription goes quiet
// instead of breaking the calendar app. A read that FAILS answers 503 instead (risk review, 26 Oct):
// an empty calendar there would tell every subscriber's app that all their interviews were cancelled.
export async function GET(request: Request, { params }: Context) {
  const headers = {
    "Cache-Control": "private, no-store",
    "Content-Disposition": 'inline; filename="phoenix-interviews.ics"',
    "Content-Type": "text/calendar; charset=utf-8",
  };
  try {
    const { token } = await params;
    // Rate-limited per address and per link (audit point 18, owner-approved 2026-10-26), BEFORE the
    // token is looked up: a 429 then says nothing about whether a token is real, and a flood of
    // guessed tokens is bounded per address before it can mint a bucket row per guess. The limits sit
    // far above any calendar app's refresh (minutes to hours), and a shared fetcher's address (Google,
    // Outlook) carries many subscribers, so the address limit is the wider one.
    await assertApiRateLimit({ identifier: rateLimitIdentity({ request }), limit: 600, scope: "interview_calendar_feed_ip", windowMs: HOUR });
    await assertApiRateLimit({ identifier: rateLimitIdentity({ request, token }), limit: 60, scope: "interview_calendar_feed_link", windowMs: HOUR });
    return new Response(await buildCalendarFeedForToken(token), { headers });
  } catch (error) {
    if (error instanceof ApiRateLimitError) {
      return new Response("Too many requests. Please try again later.", {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(error.retryAfterSeconds) },
        status: 429,
      });
    }
    // A read failed — the token, its holder, the interviews, or the limiter's own store. A 503 serves
    // nothing (fail closed) and the calendar app keeps the copy it has and asks again later; an empty
    // calendar here would wipe every interview it had synced on a database blip. It names no cause.
    return new Response("The interview calendar is temporarily unavailable. Please try again later.", {
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300" },
      status: 503,
    });
  }
}
