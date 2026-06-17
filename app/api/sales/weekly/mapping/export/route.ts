import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildWeeklyMappingWorkbook } from "@/lib/sales/weekly/mapping-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");

    const { searchParams } = new URL(request.url);
    const distributor = searchParams.get("distributor") ?? "PS";
    const buffer = await buildWeeklyMappingWorkbook(distributor);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `phoenix-weekly-mapping-${distributor}-${stamp}.xlsx`;

    return new NextResponse(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to export mapping." }, { status: 500 });
  }
}
