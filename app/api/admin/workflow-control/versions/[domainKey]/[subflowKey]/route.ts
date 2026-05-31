import {
  actorFromAccess,
  requireWorkflowControlAdmin,
  serviceResultToResponse,
} from "@/lib/workflow-control/api-helpers";
import { listWorkflowVersions } from "@/lib/workflow-control/services/versions";

/**
 * GET /api/admin/workflow-control/versions/[domainKey]/[subflowKey]
 * Disabled-safe: returns { data: [] }. Super Admin only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ domainKey: string; subflowKey: string }> };

export async function GET(request: Request, context: RouteContext) {
  const guard = await requireWorkflowControlAdmin(request);
  if (!guard.ok) return guard.response;
  const { domainKey, subflowKey } = await context.params;
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(200, Math.max(1, Number(limitRaw))) : 50;
  const result = await listWorkflowVersions(actorFromAccess(guard.access), domainKey, subflowKey, limit);
  return serviceResultToResponse(result);
}
