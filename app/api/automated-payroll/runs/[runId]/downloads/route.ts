import { NextResponse } from "next/server";

import { listRunDownloads } from "@/lib/automated-payroll/download-log";
import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every payroll file downloaded from this run: who, when, which file. Super Admin, like the wizard. */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    assertAutomatedPayrollHrActor(access);
    return NextResponse.json({ success: true, runId, downloads: await listRunDownloads(access, runId) });
  } catch (error) {
    return jsonError(error, "Failed to load the download history.");
  }
}
