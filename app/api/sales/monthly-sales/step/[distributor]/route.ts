import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { confirmStep, reopenStep } from "@/lib/sales/monthly-sales-run";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ distributor: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    void (resolveEmployeeIdentityId(access) ?? access.loginId ?? "system");

    const { distributor } = await context.params;
    const distributorCode = decodeURIComponent(distributor);
    const body = (await request.json().catch(() => ({}))) as { period?: string; action?: string; batchId?: string | null };
    const period = String(body?.period ?? "").trim();
    const action = String(body?.action ?? "confirm").trim();

    const run = action === "reopen"
      ? await reopenStep(period, distributorCode)
      : await confirmStep(period, distributorCode, body?.batchId ? String(body.batchId) : null);

    return NextResponse.json({ success: true, data: run });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Step update failed.") }, { status: 500 });
  }
}
