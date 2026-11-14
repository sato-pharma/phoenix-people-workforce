import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { bulkDecideEmployeePlans, isWeeklyPlanRpcError } from "@/lib/weekly-planning/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      planIds?: unknown;
    };
    if (!Array.isArray(body.planIds) || body.planIds.length === 0) {
      return NextResponse.json(
        { error: "invalid_request", message: "planIds must be a non-empty array.", success: false },
        { status: 400 },
      );
    }
    if (body.action !== "manager_approve") {
      return NextResponse.json(
        { error: "invalid_action", message: "Batch decisions only support manager_approve.", success: false },
        { status: 400 },
      );
    }
    const planIds = (body.planIds as unknown[]).filter((id): id is string => typeof id === "string");
    const results = await bulkDecideEmployeePlans(access, planIds, "manager_approve");
    const failed = results.filter((r) => !r.ok);
    return NextResponse.json({ data: results, failed: failed.length, success: true, total: planIds.length });
  } catch (error) {
    // The legacy form is closed (legacy-closed.ts): a refused batch says so, with its own status.
    if (isWeeklyPlanRpcError(error)) {
      return NextResponse.json(
        { error: `weekly_plan_${error.code}`, message: error.message, success: false },
        { status: error.status },
      );
    }
    const message = clientSafeErrorMessage(error, "Batch decision failed.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "batch_decision_failed", message, success: false },
      { status: isForbiddenError(error) ? 403 : 400 },
    );
  }
}
