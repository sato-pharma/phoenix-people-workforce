import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { createSourceOfSalesUploadFromBuffer } from "@/lib/sales/monthly-distributor-import";
import { buildCodedBuffer, learnFromImportHistory } from "@/lib/sales/normalizer/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-click "Import (validated)": normalize the raw sheet, build the coded workbook in memory, and run it
// through the SAME Source-of-Sales validator + insert as a manual upload. Fail-closed — it persists ONLY
// if the coded sheet validates; a blocked result returns the blocking reasons and writes NOTHING.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: Source Normalizer is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "");
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });

    const { buffer, result } = await buildCodedBuffer(distributorCode, file);
    if (result.coded.length === 0) {
      return NextResponse.json({ success: false, error: "Nothing to import — no rows could be coded. Map the exceptions first." }, { status: 400 });
    }
    // The Direct (company) channel takes its value FROM the sheet (no factory recompute), so it uses its
    // own import on Source of Sales. The validated Normalizer path is for distributor sheets only.
    if (result.coded.some((r) => r.isDirect)) {
      return NextResponse.json({ success: false, error: "Direct channel sheets use the Direct import on Source of Sales (pick 'Direct'). The validated Normalizer import is for distributor sheets." }, { status: 400 });
    }

    // Block if any rows could not be mapped — never silently drop qty.
    if (result.exceptions.length > 0) {
      const rowLines = result.exceptions.slice(0, 20).map((exc) => {
        const item = exc.rawProductName || exc.rawProduct || "?";
        const area = exc.rawTerritory || exc.rawCustomerCode || "?";
        if (exc.reason === "product") return `Row ${exc.rawRowNumber}: product "${item}" not mapped`;
        if (exc.reason === "brick") return `Row ${exc.rawRowNumber}: territory "${area}" not mapped`;
        return `Row ${exc.rawRowNumber}: product "${item}" and territory "${area}" not mapped`;
      });
      const more = result.exceptions.length > 20 ? ` …and ${result.exceptions.length - 20} more.` : "";
      return NextResponse.json({
        success: false,
        error: `${result.exceptions.length} row${result.exceptions.length === 1 ? "" : "s"} could not be imported — product or territory not mapped. Fix them in the Mapping tab then re-import.`,
        data: {
          blockingReasons: [...rowLines, more].filter(Boolean),
          failedRows: result.exceptions.length,
          importableRows: result.coded.length,
          status: "blocked",
        },
      }, { status: 400 });
    }

    const persisted = await createSourceOfSalesUploadFromBuffer({
      buffer: buffer as ArrayBuffer,
      distributorCode,
      fileName: file.name,
      persistOnlyIfValidated: true,
      uploadedBy: access.loginId ?? access.hrId ?? "admin",
    });

    if (!persisted.batchId) {
      return NextResponse.json({
        success: false,
        error: "The coded sheet did not pass validation — nothing was imported. Fix the blocking rows (e.g. map the missing bricks) and try again.",
        data: { blockingReasons: persisted.blockingReasons, failedRows: persisted.failedRows, warningRows: persisted.warningRows, status: persisted.status },
      }, { status: 400 });
    }

    // Fire-and-forget: mine the newly imported rows into the alias dictionary.
    // Errors here are non-fatal — the import already succeeded.
    learnFromImportHistory(distributorCode).catch(() => { /* non-fatal */ });

    return NextResponse.json({
      success: true,
      data: {
        batchId: persisted.batchId,
        period: persisted.period,
        importableRows: persisted.importableRows,
        warningRows: persisted.warningRows,
        exceptions: result.exceptions.length,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to import." }, { status: 500 });
  }
}
