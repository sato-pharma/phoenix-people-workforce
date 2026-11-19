import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import {
  getRunForPeriod,
  getRunView,
  startOrResumeRun,
} from "@/lib/automated-payroll/run-service";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ month, year }` — the wizard sends numbers; a numeric string is still taken (REC-060). The route's
 * own integer check below, and the service's 1-12 / 2000-2100 range, keep their own refusals.
 */
const StartRunBodySchema = z.object({
  month: z.union([z.number(), z.string()]).optional(),
  year: z.union([z.number(), z.string()]).optional(),
});

/** Start or resume the run for a period. */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, StartRunBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
    const month = Number(body.month);
    const year = Number(body.year);
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      return jsonError(new Error("Validation: month and year are required."));
    }
    const run = await startOrResumeRun(access, { month, year });
    return NextResponse.json({ success: true, run });
  } catch (error) {
    return jsonError(error, "Failed to start the payroll run.");
  }
}

/** The active/latest run + full view for a period (or null). */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const month = Number(url.searchParams.get("month"));
    const year = Number(url.searchParams.get("year"));
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      return jsonError(new Error("Validation: month and year are required."));
    }
    const run = await getRunForPeriod(access, { month, year });
    if (!run) return NextResponse.json({ success: true, run: null, view: null });
    const view = await getRunView(access, run.id);
    return NextResponse.json({ success: true, run, view });
  } catch (error) {
    return jsonError(error, "Failed to load the payroll run.");
  }
}
