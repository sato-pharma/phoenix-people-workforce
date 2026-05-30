import {
  actorFromAccess,
  invalidBodyResponse,
  readJsonBody,
  requireWorkflowControlAdmin,
  serviceResultToResponse,
} from "@/lib/workflow-control/api-helpers";
import { getWorkflowSubflow } from "@/lib/workflow-control/definitions";
import { publishWorkflowDraft } from "@/lib/workflow-control/services/publish";
import { writeWorkflowControlAudit } from "@/lib/workflow-control/services/audit";
import type { WorkflowPublishPayload } from "@/lib/workflow-control/governance";

/**
 * POST /api/admin/workflow-control/publish/[draftId]
 * Validates + hashes + diffs the draft, then returns 503 publish_disabled.
 * Super Admin only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ draftId: string }> };

type PublishBody = {
  domainKey?: string;
  subflowKey?: string;
  draftPayload?: WorkflowPublishPayload;
  currentPayload?: WorkflowPublishPayload | null;
  notes?: string;
};

export async function POST(request: Request, context: RouteContext) {
  const guard = await requireWorkflowControlAdmin(request);
  if (!guard.ok) return guard.response;

  const { draftId } = await context.params;
  const body = await readJsonBody<PublishBody>(request);
  if (!body || !body.draftPayload || !body.domainKey || !body.subflowKey) {
    return invalidBodyResponse("Body must include `domainKey`, `subflowKey`, and `draftPayload`.");
  }

  const subflow = getWorkflowSubflow(body.domainKey, body.subflowKey);
  const validStepIds = subflow?.steps.map((s) => s.id);
  const actor = actorFromAccess(guard.access);

  const result = await publishWorkflowDraft(actor, {
    draftId,
    domainKey: body.domainKey,
    subflowKey: body.subflowKey,
    draftPayload: body.draftPayload,
    currentPayload: body.currentPayload ?? null,
    validStepIds,
    steps: subflow?.steps,
    notes: body.notes,
  });
  await writeWorkflowControlAudit(actor, {
    action: "publish_version",
    draftId,
    metadata: { domainKey: body.domainKey, subflowKey: body.subflowKey, code: result.ok ? "ok" : result.code },
  });
  return serviceResultToResponse(result);
}
