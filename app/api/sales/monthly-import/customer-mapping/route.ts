import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importCustomerMap } from "@/lib/sales/normalizer/customer-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const formData = await request.formData();
    const formFile = formData.get("file");
    const file = formFile instanceof File ? formFile : null;
    if (!file) {
      return NextResponse.json({ success: false, error: "A customer mapping file is required." }, { status: 400 });
    }

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importCustomerMap({ actorLoginId, file });
    const blocked = result.blockedRows.length > 0;

    return NextResponse.json(
      {
        success: !blocked,
        result,
        error: blocked ? "Some rows could not be imported. Fix the listed rows and re-upload." : undefined,
        message: blocked
          ? "Import blocked."
          : `${result.inserted} added, ${result.updated} updated, ${result.skipped} skipped.`,
      },
      { status: blocked ? 400 : 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code, details: error.details }, { status: error.status });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to import the customer mapping." },
      { status: 500 },
    );
  }
}
