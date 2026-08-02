import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { setCrmRegionBrickResolution, type CrmRegionResolutionAction } from "@/lib/crm/region-brick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actions: readonly CrmRegionResolutionAction[] = ["ignored", "mapped", "pending"];

function actionParam(value: unknown): CrmRegionResolutionAction | null {
  return actions.includes(value as CrmRegionResolutionAction) ? (value as CrmRegionResolutionAction) : null;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!canUseAdminCrmWorkspace(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "This action is limited to the admin CRM workspace roles.", success: false },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      brickId?: unknown;
      crmRegionId?: unknown;
      crmRegionName?: unknown;
    };
    const crmRegionId = Number(body.crmRegionId);
    const action = actionParam(body.action);
    if (!Number.isFinite(crmRegionId) || crmRegionId < 0 || !action) {
      return NextResponse.json(
        { error: "invalid_input", message: "A valid crmRegionId and action (mapped/pending/ignored) are required.", success: false },
        { status: 400 },
      );
    }

    const result = await setCrmRegionBrickResolution({
      action,
      brickId: typeof body.brickId === "string" ? body.brickId : null,
      crmRegionId,
      crmRegionName: typeof body.crmRegionName === "string" ? body.crmRegionName : null,
      resolvedByHrId: access.hrId ?? null,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve this CRM region.";
    return NextResponse.json({ error: "resolve_region_failed", message, success: false }, { status: 400 });
  }
}
