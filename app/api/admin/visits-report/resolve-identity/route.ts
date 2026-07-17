import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { setUnmappedCrmIdentityResolution } from "@/lib/crm/admin";
import type { UnmappedCrmResolutionAction } from "@/lib/visits-report/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actions: readonly UnmappedCrmResolutionAction[] = ["mapped", "pending", "resigned"];

function actionParam(value: unknown): UnmappedCrmResolutionAction | null {
  return actions.includes(value as UnmappedCrmResolutionAction) ? (value as UnmappedCrmResolutionAction) : null;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        { error: "forbidden", message: "Only Super Admin can resolve unmapped CRM identities.", success: false },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      crmId?: unknown;
      crmName?: unknown;
      mappedHrId?: unknown;
    };
    const crmId = Number(body.crmId);
    const action = actionParam(body.action);
    if (!Number.isFinite(crmId) || crmId <= 0 || !action) {
      return NextResponse.json(
        { error: "invalid_input", message: "A valid crmId and action (mapped/pending/resigned) are required.", success: false },
        { status: 400 },
      );
    }

    const result = await setUnmappedCrmIdentityResolution({
      action,
      crmId,
      crmName: typeof body.crmName === "string" ? body.crmName : null,
      mappedHrId: typeof body.mappedHrId === "string" ? body.mappedHrId : null,
      resolvedByHrId: access.hrId ?? null,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve this CRM identity.";
    return NextResponse.json({ error: "resolve_identity_failed", message, success: false }, { status: 400 });
  }
}
