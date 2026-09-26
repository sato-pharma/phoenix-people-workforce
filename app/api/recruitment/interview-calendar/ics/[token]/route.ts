import { buildCalendarFeedForToken, renderCalendarFeed } from "@/lib/recruitment/interview-calendar-ics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

// The per-person .ics subscription feed. Reached by a bearer token, NOT a Phoenix sign-in — a
// calendar app (Outlook, Google, the phone) cannot sign in. The token resolves to one hr id and the
// feed carries only that person's own interviews. An unknown or retired token returns a valid EMPTY
// calendar, never an error, so a stale subscription goes quiet instead of breaking the calendar app.
export async function GET(_request: Request, { params }: Context) {
  const headers = {
    "Cache-Control": "private, no-store",
    "Content-Disposition": 'inline; filename="phoenix-interviews.ics"',
    "Content-Type": "text/calendar; charset=utf-8",
  };
  try {
    const { token } = await params;
    return new Response(await buildCalendarFeedForToken(token), { headers });
  } catch {
    // Never surface an error to a calendar app — hand back an empty but valid calendar.
    return new Response(renderCalendarFeed([]), { headers });
  }
}
