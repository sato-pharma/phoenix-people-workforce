import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getFinanceAvailability } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which finance downloads are available for a period (drives the finance dropdown). */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const month = Number(url.searchParams.get("month"));
    const year = Number(url.searchParams.get("year"));
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      return jsonError(new Error("Validation: month and year are required."));
    }
    const availability = await getFinanceAvailability(access, { month, year });
    return NextResponse.json({ success: true, availability });
  } catch (error) {
    return jsonError(error, "Failed to load finance availability.");
  }
}
