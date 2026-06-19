import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { buildMasterWorkbookBuffer } from "@/lib/sales/master-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The workbook can be large (tens of thousands of rows across the detail sheets); allow headroom.
export const maxDuration = 60;

// Read-only: builds the full 17-sheet master workbook from LIVE system data and streams it as XLSX.
// Persists nothing. Reflects the current masters, aliases, customers, and imported sales every call.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");

    // Confidential products (LA003 / LA004) are included in the export only for CEO / Super Admin.
    const buffer = await buildMasterWorkbookBuffer({
      includeRestricted: canViewRestrictedProducts(access.role),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `phoenix-master-workbook-${stamp}.xlsx`;
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Export failed." }, { status: 500 });
  }
}
