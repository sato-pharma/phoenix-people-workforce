import { NextResponse } from "next/server";

import { listWorkflowDomains } from "@/lib/workflow-control/definitions";
import { requireWorkflowControlAdmin } from "@/lib/workflow-control/api-helpers";

/**
 * GET /api/admin/workflow-control/definitions
 *
 * Read-only listing of the static workflow domains + subflows. Super Admin only.
 * Does NOT query workflow_control DB tables.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireWorkflowControlAdmin(request);
  if (!guard.ok) return guard.response;

  const domains = listWorkflowDomains();
  return NextResponse.json({ data: { domains }, success: true });
}
