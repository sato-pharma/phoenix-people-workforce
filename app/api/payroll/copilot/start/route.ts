import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
import { CopilotError, startRun } from "@/lib/payroll/copilot/service";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The workbench sends `{ month, year }` as numbers. A numeric string is accepted too, and the route
 * still coerces with Number() and refuses a non-integer with its own "A valid payroll month and year
 * are required." answer.
 */
const CopilotStartBodySchema = z.object({
  month: z.union([z.number(), z.string()]).nullish(),
  year: z.union([z.number(), z.string()]).nullish(),
});

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);

    const parsed = await parseJsonBody(request, CopilotStartBodySchema, { fallback: {} });
    if (!parsed.ok) throw new CopilotError(parsed.message, 400);
    const body = parsed.data;
    const month = Number(body.month);
    const year = Number(body.year);
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      throw new CopilotError("A valid payroll month and year are required.", 400);
    }
    try {
      assertValidPayrollPeriod(month, year);
    } catch (error) {
      throw new CopilotError(clientSafeErrorMessage(error, "Invalid payroll period."), 400);
    }

    const view = await startRun({ month, year }, resolveCopilotActor(access));
    return NextResponse.json(view);
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
