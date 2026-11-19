import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { setCarryLateExpenses } from "@/lib/automated-payroll/late-expenses";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ on: boolean }` (REC-060). A missing `on` still gets the route's own "say whether" refusal below. */
const CarryLateExpensesBodySchema = z.object({
  on: z.boolean().optional(),
});

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
    assertSignedIn(access);
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, CarryLateExpensesBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
    if (typeof body.on !== "boolean") {
      return jsonError(new Error("Validation: say whether the switch is on or off."));
    }
    const setting = await setCarryLateExpenses(access, body.on);
    return NextResponse.json({ success: true, setting });
  } catch (error) {
    return jsonError(error, "Failed to change the payroll switch.");
  }
}
