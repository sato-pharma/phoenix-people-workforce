import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { resolveSalesUploadRequest } from "@/lib/sales/monthly-import-request";
import { importSourceOfSalesFile } from "@/lib/sales/source-of-sales-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dry-run preview: validate + summarize the upload WITHOUT persisting anything. The response carries
// the validation result plus `previewDiff` (resolved %, new/unmapped customers, brick drift). For the
// large-file path the Storage object is intentionally KEPT so the follow-up /commit can reuse it; the
// browser keeps small files in memory.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const resolved = await resolveSalesUploadRequest(request);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error, success: false, ...(resolved.code ? { code: resolved.code } : {}) }, { status: resolved.status });
    }

    const uploadedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importSourceOfSalesFile({
      distributorCode: resolved.distributorCode,
      dryRun: true,
      file: resolved.file,
      periodOverride: resolved.period,
      uploadedBy,
    });
    const blocked = result.status === "blocked";

    return NextResponse.json(
      {
        data: result,
        // Echo the storage reference so the client can pass it straight to /commit (large-file path).
        storagePath: resolved.storagePath,
        error: blocked ? "Some rows are unmapped. Map them, then re-upload — nothing was imported." : undefined,
        message: blocked ? "Preview blocked." : "Preview ready.",
        success: !blocked,
      },
      { status: blocked ? 400 : 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Forbidden.", success: false }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ code: error.code, details: error.details, error: error.message, success: false }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sales preview failed.", success: false }, { status: 500 });
  }
}
