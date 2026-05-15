import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { syncPublicHolidaysFromGoogleCalendar } from "@/lib/leave/service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({}));
    const result = await syncPublicHolidaysFromGoogleCalendar(access, {
      country: typeof body.country === "string" ? body.country : "EG",
      year: Number.isFinite(Number(body.year)) ? Number(body.year) : new Date().getUTCFullYear(),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to sync Google Calendar national vacations.";
    const status = message.includes("public_holidays.end_date") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
