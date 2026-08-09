import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { addCustomerMapRow } from "@/lib/sales/normalizer/customer-map";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Inline "add by field" — map ONE customer code to a Brick ID (Area/Region derive from the brick).
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as {
      distributorCode?: string;
      customerCode?: string;
      customerName?: string;
      address?: string;
      brickId?: string;
    };
    const distributorCode = String(body.distributorCode ?? "").trim();
    const customerCode = String(body.customerCode ?? "").trim();
    const brickId = String(body.brickId ?? "").trim();
    if (!distributorCode || !customerCode || !brickId) {
      return NextResponse.json({ success: false, error: "Distributor, customer code, and brick are required." }, { status: 400 });
    }

    await addCustomerMapRow({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      address: String(body.address ?? "").trim(),
      brickId,
      customerCode,
      customerName: String(body.customerName ?? "").trim(),
      distributorCode,
    });
    return NextResponse.json({ success: true, message: `Customer ${customerCode} mapped to brick ${brickId}.` });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to add the customer mapping.") },
      { status: 500 },
    );
  }
}
