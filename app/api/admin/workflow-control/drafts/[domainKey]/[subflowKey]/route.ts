import {
  actorFromAccess,
  invalidBodyResponse,
  readJsonBody,
  requireWorkflowControlAdmin,
  serviceResultToResponse,
} from "@/lib/workflow-control/api-helpers";
import { getWorkflowSubflow } from "@/lib/workflow-control/definitions";
import { loadWorkflowDraft, saveWorkflowDraft } from "@/lib/workflow-control/services/drafts";
import { writeWorkflowControlAudit } from "@/lib/workflow-control/services/audit";
import type { WorkflowPublishPayload } from "@/lib/workflow-control/governance";

/**
 * GET  /api/admin/workflow-control/drafts/[domainKey]/[subflowKey]  — load draft (disabled-safe: null).
 * PUT  /api/admin/workflow-control/drafts/[domainKey]/[subflowKey]  — save draft (Phase 3D: 503 disabled).
 * Super Admin only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ domainKey: string; subflowKey: string }> };

export async function GET(request: Request, context: RouteContext) {
  const guard = await requireWorkflowControlAdmin(request);
  if (!guard.ok) return guard.response;
  const { domainKey, subflowKey } = await context.params;
  const result = await loadWorkflowDraft(actorFromAccess(guard.access), domainKey, subflowKey);
  return serviceResultToResponse(result);
}

export async function PUT(request: Request, context: RouteContext) {
  const guard = await requireWorkflowControlAdmin(request);
  if (!guard.ok) return guard.response;
  const { domainKey, subflowKey } = await context.params;
  const body = await readJsonBody<{ payload?: WorkflowPublishPayload }>(request);
  if (!body || !body.payload) {
    return invalidBodyResponse("Body must include a `payload` object.");
  }
  const subflow = getWorkflowSubflow(domainKey, subflowKey);
  const validStepIds = subflow?.steps.map((s) => s.id);
  const actor = actorFromAccess(guard.access);
  const result = await saveWorkflowDraft(actor, { domainKey, subflowKey, payload: body.payload, validStepIds });
  await writeWorkflowControlAudit(actor, {
    action: "save_draft",
    metadata: { domainKey, subflowKey, code: result.ok ? "ok" : result.code },
  });
  return serviceResultToResponse(result);
}
