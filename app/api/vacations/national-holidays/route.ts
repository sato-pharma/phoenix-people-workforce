import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";

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
    const result = await getEgyptianNationalHolidays({ month, year });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load Egyptian national holidays.";
    if (isForbiddenError(error) || message.toLowerCase().includes("forbidden")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    return NextResponse.json({ error: "national_holidays_failed", message, success: false }, { status: 400 });
  }
}
