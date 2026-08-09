import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { skipStep } from "@/lib/sales/monthly-sales-run";
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
    const body = (await request.json().catch(() => ({}))) as { period?: string; reason?: string };
    const period = String(body?.period ?? "").trim();
    const reason = String(body?.reason ?? "");

    const run = await skipStep(period, distributorCode, reason);
    return NextResponse.json({ success: true, data: run });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Skip failed.") }, { status: 500 });
  }
}
