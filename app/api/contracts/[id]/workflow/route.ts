import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  contractRenewalErrorMessage,
  getContractRenewalDashboardData,
  isContractRenewalSchemaMissing,
  isContractRenewalValidationError,
  runContractRenewalWorkflow,
} from "@/lib/contracts/service";
import type { ContractRenewalAction } from "@/lib/contracts/types";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const action = String(body.action ?? "") as ContractRenewalAction;
    const validActions: ContractRenewalAction[] = [
      "manager_review",
      "hr_review",
      "renew",
      "not_renew",
      "upload_signed",
      "cancel",
    ];

    if (!validActions.includes(action)) {
      return NextResponse.json({ success: false, error: "Invalid action." }, { status: 400 });
    }

    await assertPermission(
      access,
      "contracts",
      action === "renew" || action === "not_renew" ? "approve" : "update",
    );

    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const data = await runContractRenewalWorkflow(id, action, actor, {
      access,
      decisionReason: body.decisionReason ? String(body.decisionReason) : undefined,
      newContractDocumentName: body.newContractDocumentName ? String(body.newContractDocumentName) : undefined,
      newContractDocumentUrl: body.newContractDocumentUrl ? String(body.newContractDocumentUrl) : undefined,
      note: body.note ? String(body.note) : undefined,
      signedContractName: body.signedContractName ? String(body.signedContractName) : undefined,
      signedContractUrl: body.signedContractUrl ? String(body.signedContractUrl) : undefined,
    });

    if (!data) {
      return NextResponse.json({ success: false, error: "Contract renewal request not found." }, { status: 404 });
    }

    return NextResponse.json({
      dashboard: await getContractRenewalDashboardData(access),
      data,
      success: true,
    });
  } catch (error) {
    const message = contractRenewalErrorMessage(error);
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 403 });
    }
    if (isContractRenewalSchemaMissing(error)) {
      return NextResponse.json({ success: false, error: "Contract renewal workflow schema is not ready." }, { status: 409 });
    }
    if (isContractRenewalValidationError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
