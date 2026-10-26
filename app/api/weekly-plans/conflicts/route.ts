import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getSameLinePlanBookings } from "@/lib/weekly-planning/calendar-service";
import { sameLineBookingRangeProblem } from "@/lib/weekly-planning/calendar";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string) {
  const message = clientSafeErrorMessage(error, fallback);
  const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "planning_conflict_error", message, success: false },
    { status: forbidden ? 403 : 400 },
  );
}

function validDate(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const start = validDate(url.searchParams.get("start"));
    const end = validDate(url.searchParams.get("end"));
    // One plan period at a time: an open-ended range would read every submitted plan of the year.
    const rangeProblem = start && end ? sameLineBookingRangeProblem(start, end) : "A valid start and end date are required.";
    if (!start || !end || rangeProblem) {
      return NextResponse.json(
        { error: "invalid_range", message: rangeProblem, success: false },
        { status: 400 },
      );
    }
    const bookings = await getSameLinePlanBookings(access, start, end);
    return NextResponse.json({ data: { bookings }, success: true });
  } catch (error) {
    return jsonError(error, "Unable to load planning conflicts.");
  }
}
