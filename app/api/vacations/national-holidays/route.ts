import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { employeeHolidayList } from "@/lib/vacation/employee-holiday-list";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function numberParam(value: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "leave", "read");

    const url = new URL(request.url);
    const now = new Date();
    const year = numberParam(url.searchParams.get("year")) || now.getFullYear();
    const month = numberParam(url.searchParams.get("month")) || now.getMonth() + 1;
    const result = await getConfirmedNationalHolidays({ month, year });
    // This list is read only by the Vacation Request form's National Holidays tab — every employee
    // sees it. The confirming administrator's notes are dropped and a day off confirmed twice is one
    // row (employee-holiday-list.ts); no leave rule reads this response.
    return NextResponse.json({ success: true, ...result, holidays: employeeHolidayList(result.holidays) });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to load Egyptian national holidays.");
    if (isForbiddenError(error) || message.toLowerCase().includes("forbidden")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    return NextResponse.json({ error: "national_holidays_failed", message, success: false }, { status: 400 });
  }
}
