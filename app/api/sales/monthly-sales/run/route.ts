import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadRun, startOrGetRun } from "@/lib/sales/monthly-sales-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Monthly Sales run failed." }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const body = (await request.json().catch(() => ({}))) as { period?: string };
    const period = String(body?.period ?? "").trim();
    const actorId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const run = await startOrGetRun(period, actorId);
    return NextResponse.json({ success: true, data: run });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const period = new URL(request.url).searchParams.get("period")?.trim() ?? "";
    const run = await loadRun(period);
    return NextResponse.json({ success: true, data: run });
  } catch (error) {
    return errorResponse(error);
  }
}
