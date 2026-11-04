import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listSourceOfSalesUploadBatches } from "@/lib/sales/monthly-distributor-import";
import { readsUnpublishedSalesTools } from "@/lib/sales/unpublished-sales-access";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    // `sales:read` reaches every role, and the list prints each upload's totals before its closing is
    // published. Only the two roles that run the import read it (owner, 2026-11-04).
    if (!readsUnpublishedSalesTools(access)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    const data = await listSourceOfSalesUploadBatches();

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: clientSafeErrorMessage(error, "Failed to load uploaded Source of Sales sheets."),
      },
      { status: 500 },
    );
  }
}
