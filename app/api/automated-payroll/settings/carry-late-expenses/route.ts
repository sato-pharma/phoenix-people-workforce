import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { setCarryLateExpenses } from "@/lib/automated-payroll/late-expenses";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { on: boolean }: the payroll switch for outstation trips approved after their payout month was
 * published (owner's decision: "Switch, starts OFF"). OFF lists them only; ON adds them to the next open
 * run's Expenses step. Refused (409) while any run is in Part 2 or confirmed — late-expenses.ts.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { on?: unknown };
    if (typeof body.on !== "boolean") {
      return jsonError(new Error("Validation: say whether the switch is on or off."));
    }
    const setting = await setCarryLateExpenses(access, body.on);
    return NextResponse.json({ success: true, setting });
  } catch (error) {
    return jsonError(error, "Failed to change the payroll switch.");
  }
}
