import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getLateExpensesOverview } from "@/lib/automated-payroll/late-expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET ?month=&year=: the payroll switch for late-approved expenses, and the approved outstation trips of
 * earlier, already published payout months that no run has paid yet (late-expenses.ts, REC-029).
 *
 * Names people and money — the same gate as the wizard itself. A failed read answers 409 with its words,
 * never an empty list.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const month = Number(url.searchParams.get("month"));
    const year = Number(url.searchParams.get("year"));
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
      return jsonError(new Error("Validation: month and year are required."));
    }
    const overview = await getLateExpensesOverview(access, { month, year });
    return NextResponse.json({ success: true, ...overview });
  } catch (error) {
    return jsonError(error, "Failed to load the approved expenses not yet in a run.");
  }
}
