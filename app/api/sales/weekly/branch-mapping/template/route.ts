import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { buildBranchRegionTemplate, type WeeklyBranchFileType } from "@/lib/sales/weekly/branch-region-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fileType(value: string | null | undefined): WeeklyBranchFileType {
  const key = String(value ?? "").trim().toLowerCase();
  return key === "sales" || key === "stock" ? key : "any";
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");
    const params = new URL(request.url).searchParams;
    const distributor = params.get("distributor")?.trim();
    if (!distributor) {
      return NextResponse.json({ success: false, error: "A distributor is required." }, { status: 400 });
    }
    const ft = fileType(params.get("fileType"));
    const buffer = await buildBranchRegionTemplate(distributor, ft);
    const suffix = ft === "any" ? "" : `-${ft}`;
    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="weekly-branch-mapping-${distributor}${suffix}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to build the branch mapping template." },
      { status: 500 },
    );
  }
}
