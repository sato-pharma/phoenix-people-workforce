import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { setCrmCustomerBrickResolution, type CrmCustomerResolutionAction } from "@/lib/crm/customer-brick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actions: readonly CrmCustomerResolutionAction[] = ["ignored", "mapped", "pending"];

function actionParam(value: unknown): CrmCustomerResolutionAction | null {
  return actions.includes(value as CrmCustomerResolutionAction) ? (value as CrmCustomerResolutionAction) : null;
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
      crmContactId?: unknown;
      crmContactName?: unknown;
    };
    const crmContactId = Number(body.crmContactId);
    const action = actionParam(body.action);
    if (!Number.isFinite(crmContactId) || crmContactId <= 0 || !action) {
      return NextResponse.json(
        { error: "invalid_input", message: "A valid crmContactId and action (mapped/pending/ignored) are required.", success: false },
        { status: 400 },
      );
    }

    const result = await setCrmCustomerBrickResolution({
      action,
      brickId: typeof body.brickId === "string" ? body.brickId : null,
      crmContactId,
      crmContactName: typeof body.crmContactName === "string" ? body.crmContactName : null,
      resolvedByHrId: access.hrId ?? null,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve this CRM customer.";
    return NextResponse.json({ error: "resolve_customer_failed", message, success: false }, { status: 400 });
  }
}
