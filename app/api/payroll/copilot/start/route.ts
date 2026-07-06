import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
import { CopilotError, startRun } from "@/lib/payroll/copilot/service";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);

    const body = (await request.json().catch(() => ({}))) as { month?: unknown; year?: unknown };
    const month = Number(body.month);
    const year = Number(body.year);
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      throw new CopilotError("A valid payroll month and year are required.", 400);
    }
    try {
      assertValidPayrollPeriod(month, year);
    } catch (error) {
      throw new CopilotError(error instanceof Error ? error.message : "Invalid payroll period.", 400);
    }

    const view = await startRun({ month, year }, resolveCopilotActor(access));
    return NextResponse.json(view);
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
