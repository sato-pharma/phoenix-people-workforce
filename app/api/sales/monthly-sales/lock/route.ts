import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { lockPeriod, reopenPeriod } from "@/lib/sales/monthly-sales-run";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Locking or reopening a Monthly Sales period is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");
    const actorId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    const body = (await request.json().catch(() => ({}))) as { period?: string; action?: string };
    const period = String(body?.period ?? "").trim();
    const action = String(body?.action ?? "lock").trim();

    const run = action === "reopen" ? await reopenPeriod(period, actorId) : await lockPeriod(period, actorId);
    return NextResponse.json({ success: true, data: run });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Lock action failed.") }, { status: 500 });
  }
}
