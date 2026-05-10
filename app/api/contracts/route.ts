import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  contractRenewalErrorMessage,
  createContractRenewalRequest,
  getContractRenewalDashboardData,
  isContractRenewalSchemaMissing,
} from "@/lib/contracts/service";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "contracts", "update");

    const body = await request.json();
    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const data = await createContractRenewalRequest(
      {
        employeeHrId: String(body.employeeHrId ?? ""),
        newContractDocumentName: body.newContractDocumentName ? String(body.newContractDocumentName) : undefined,
        newContractDocumentUrl: body.newContractDocumentUrl ? String(body.newContractDocumentUrl) : undefined,
        proposedEndDate: body.proposedEndDate ? String(body.proposedEndDate) : undefined,
        proposedStartDate: body.proposedStartDate ? String(body.proposedStartDate) : undefined,
        requestedRenewalDate: body.requestedRenewalDate ? String(body.requestedRenewalDate) : undefined,
        workflowNotes: body.workflowNotes ? String(body.workflowNotes) : undefined,
      },
      actor,
    );

    return NextResponse.json({
      dashboard: await getContractRenewalDashboardData(),
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
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
