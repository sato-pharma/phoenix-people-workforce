import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { isMasterKey } from "@/lib/sales/master-data/definitions";
import { importMasterWorkbook } from "@/lib/sales/master-data/import-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ master: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const { master } = await context.params;
    if (!isMasterKey(master)) {
      return NextResponse.json({ success: false, error: "Unknown master table." }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "Master workbook file is required." }, { status: 400 });
    }

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importMasterWorkbook({ actorLoginId, file, master });

    return NextResponse.json({
      success: true,
      data: result,
      message: `${result.inserted} added, ${result.updated} updated, ${result.skipped} unchanged, ${result.blockedRows.length} blocked.`,
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
      { success: false, error: clientSafeErrorMessage(error, "Master import failed.") },
      { status: 500 },
    );
  }
}
