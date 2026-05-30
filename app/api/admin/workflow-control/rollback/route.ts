import {
  actorFromAccess,
  invalidBodyResponse,
  readJsonBody,
  requireWorkflowControlAdmin,
  serviceResultToResponse,
} from "@/lib/workflow-control/api-helpers";
import { rollbackWorkflowVersion } from "@/lib/workflow-control/services/publish";
import { writeWorkflowControlAudit } from "@/lib/workflow-control/services/audit";

/**
 * POST /api/admin/workflow-control/rollback
 * Phase 3D: returns 503 rollback_disabled. Super Admin only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RollbackBody = {
  definitionId?: string;
  versionId?: string;
  reason?: string;
};

export async function POST(request: Request) {
  const guard = await requireWorkflowControlAdmin(request);
  if (!guard.ok) return guard.response;

  const body = await readJsonBody<RollbackBody>(request);
  if (!body || !body.definitionId || !body.versionId) {
    return invalidBodyResponse("Body must include `definitionId` and `versionId`.");
  }

  const actor = actorFromAccess(guard.access);
  const result = await rollbackWorkflowVersion(actor, {
    definitionId: body.definitionId,
    versionId: body.versionId,
    reason: body.reason,
  });
  await writeWorkflowControlAudit(actor, {
    action: "rollback",
    definitionId: body.definitionId,
    versionId: body.versionId,
    metadata: { reason: body.reason ?? null, code: result.ok ? "ok" : result.code },
  });
  return serviceResultToResponse(result);
}
