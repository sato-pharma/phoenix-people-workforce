import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importCustomerMap } from "@/lib/sales/normalizer/customer-map";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bulk import of the customer→brick crosswalk: download the export, fix Brick IDs / add rows, re-upload.
// Upserts WITH UPDATE (validated against the brick + distributor masters); returns a rejected-rows list.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "Customer map file is required." }, { status: 400 });
    }

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importCustomerMap({ actorLoginId, file });

    return NextResponse.json({
      success: true,
      data: result,
      message: `${result.inserted} added, ${result.updated} updated, ${result.skipped} skipped, ${result.blockedRows.length} blocked.`,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Customer map import failed.") },
      { status: 500 },
    );
  }
}
