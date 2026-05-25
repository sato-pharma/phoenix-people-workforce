import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listSourceOfSalesUploadBatches } from "@/lib/sales/monthly-distributor-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    const data = await listSourceOfSalesUploadBatches();

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load uploaded Source of Sales sheets.",
      },
      { status: 500 },
    );
  }
}
