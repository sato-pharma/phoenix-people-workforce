import {
  actorFromAccess,
  requireWorkflowControlAdmin,
  serviceResultToResponse,
} from "@/lib/workflow-control/api-helpers";
import { discardWorkflowDraft } from "@/lib/workflow-control/services/drafts";
import { writeWorkflowControlAudit } from "@/lib/workflow-control/services/audit";

/**
 * DELETE /api/admin/workflow-control/drafts/by-id/[draftId]
 * Uses static /by-id/ segment to avoid a Next.js dynamic-segment collision
 * with the GET/PUT route under /drafts/[domainKey]/[subflowKey].
 * Phase 3D: returns 503 persistence_disabled. Super Admin only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ draftId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const guard = await requireWorkflowControlAdmin(request);
  if (!guard.ok) return guard.response;
  const { draftId } = await context.params;
  const actor = actorFromAccess(guard.access);
  const result = await discardWorkflowDraft(actor, draftId);
  await writeWorkflowControlAudit(actor, {
    action: "discard_draft",
    draftId,
    metadata: { code: result.ok ? "ok" : result.code },
  });
  return serviceResultToResponse(result);
}
