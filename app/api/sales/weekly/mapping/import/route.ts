import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importWeeklyMappingWorkbook } from "@/lib/sales/weekly/mapping-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");

    const formData = await request.formData();
    const file = formData.get("file");
    const distributor = String(formData.get("distributor") ?? "").trim();
    if (!distributor) {
      return NextResponse.json({ success: false, error: "Pick a distributor before uploading." }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "Mapping workbook (.xlsx) is required." }, { status: 400 });
    }

    const actorId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importWeeklyMappingWorkbook({ actorId, distributorCode: distributor, file });
    const blocked = result.blockedRows.length > 0;
    return NextResponse.json(
      {
        success: true,
        result,
        message: `${result.inserted} added, ${result.updated} updated, ${result.skipped} skipped${blocked ? `, ${result.blockedRows.length} blocked` : ""}.`,
      },
      { status: 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to import mapping." }, { status: 500 });
  }
}
