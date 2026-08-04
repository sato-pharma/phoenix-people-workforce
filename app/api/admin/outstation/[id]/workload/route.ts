import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  retryOutstationWorkloadCapture,
  setOutstationWorkloadManually,
} from "@/lib/outstation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Repair the workload on a request the gate is holding.
 *
 *   { action: "retry"  }                                  -> re-run the CRM grab
 *   { action: "manual", amWorkload, pmWorkload, reason }   -> a Super Admin types it in
 *
 * Both are Super Admin only, enforced inside the service (assertOutstationAdminAccess with
 * "approve", which excludes the execution-only finance roles). The route does not re-implement
 * that check — one authority for it, in the domain.
 */
function workloadRepairStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("not waiting on its workload")) return 409;
  if (
    message.includes("required") ||
    message.includes("must be") ||
    message.includes("not available") ||
    message.includes("invalid")
  ) {
    return 400;
  }
  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "retry");

    if (action === "manual") {
      const result = await setOutstationWorkloadManually(id, access, {
        amWorkload: Number(body.amWorkload ?? 0),
        pmWorkload: Number(body.pmWorkload ?? 0),
        reason: String(body.reason ?? ""),
      });
      return NextResponse.json({ ...result, success: true });
    }

    if (action !== "retry") {
      return NextResponse.json(
        { error: "invalid_action", message: 'Action must be "retry" or "manual".' },
        { status: 400 },
      );
    }

    const result = await retryOutstationWorkloadCapture(id, access);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_workload_repair_failed",
        message: error instanceof Error ? error.message : "Unable to repair the workload.",
      },
      { status: workloadRepairStatus(error) },
    );
  }
}
