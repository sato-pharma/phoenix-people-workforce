import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  getRunForPeriod,
  getRunView,
  startOrResumeRun,
} from "@/lib/automated-payroll/run-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start or resume the run for a period. */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { month?: number; year?: number };
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
