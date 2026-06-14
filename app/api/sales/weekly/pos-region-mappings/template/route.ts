import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildWeeklyPosRegionMappingTemplate } from "@/lib/sales/weekly/pos-region-mappings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const buffer = await buildWeeklyPosRegionMappingTemplate();
    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="phoenix-weekly-pos-region-mapping.xlsx"',
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to build POS region mapping template." },
      { status: 500 },
    );
  }
}
