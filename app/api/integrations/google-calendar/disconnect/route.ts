import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { disconnectGoogleCalendar } from "@/lib/weekly-planning/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await disconnectGoogleCalendar(access);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "google_calendar_disconnect_failed",
        message: error instanceof Error ? error.message : "Unable to disconnect Google Calendar.",
        success: false,
      },
      { status: 400 },
    );
  }
}
