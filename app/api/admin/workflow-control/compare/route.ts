import {
  actorFromAccess,
  invalidBodyResponse,
  readJsonBody,
  requireWorkflowControlAdmin,
  serviceResultToResponse,
} from "@/lib/workflow-control/api-helpers";
import { getWorkflowSubflow } from "@/lib/workflow-control/definitions";
import { compareWorkflowVersions } from "@/lib/workflow-control/services/versions";
import { writeWorkflowControlAudit } from "@/lib/workflow-control/services/audit";
import type { WorkflowPublishPayload } from "@/lib/workflow-control/governance";

/**
 * POST /api/admin/workflow-control/compare
 * PURE diff via Phase 3A buildWorkflowPublishDiffSummary — no DB. Super Admin only.
 * (POST used because the request carries two JSON payloads in the body.)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CompareBody = {
  from?: WorkflowPublishPayload | null;
  to?: WorkflowPublishPayload;
  domainKey?: string;
  subflowKey?: string;
};

export async function POST(request: Request) {
  const guard = await requireWorkflowControlAdmin(request);
  if (!guard.ok) return guard.response;

  const body = await readJsonBody<CompareBody>(request);
  if (!body || !body.to) {
    return invalidBodyResponse("Body must include a `to` payload (and optionally `from`, `domainKey`, `subflowKey`).");
  }

  const steps = body.domainKey && body.subflowKey
    ? getWorkflowSubflow(body.domainKey, body.subflowKey)?.steps
    : undefined;

  const actor = actorFromAccess(guard.access);
  const result = compareWorkflowVersions(actor, body.from ?? null, body.to, { steps });
  await writeWorkflowControlAudit(actor, {
    action: "compare",
    metadata: { domainKey: body.domainKey ?? null, subflowKey: body.subflowKey ?? null, code: result.ok ? "ok" : result.code },
  });
  return serviceResultToResponse(result);
}
