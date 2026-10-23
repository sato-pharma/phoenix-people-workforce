import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { downloadSalesUploadFile, removeSalesUploadObject } from "@/lib/sales/monthly-import-request";
import { isOwnSalesImportUploadPath, SALES_UPLOAD_PATH_REFUSAL } from "@/lib/sales/sales-import-upload-path";
import { importSourceOfSalesFile } from "@/lib/sales/source-of-sales-upload";
import { salesSpreadsheetValidation, spreadsheetTooLargeMessage, spreadsheetUploadLimitBytes, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Validation only: it answers whether the workbook would import, and writes nothing. It runs the
// import as a dry run, so no batch, row or coverage snapshot is saved; importing is the commit
// route's job, after the preview.
export async function POST(request: Request) {
  // For the large-file path we hold the temp storage object and delete it once processing is done
  // (success or failure), so the bucket only ever holds in-flight uploads.
  let cleanupStoragePath: string | null = null;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    let file: File | null = null;
    let distributorCode = "";
    let period = "";
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      // Large-file path: the browser already uploaded the workbook straight to Storage (bypassing the
      // ~4.5MB serverless body cap) and now passes its storagePath. Download + process it server-side.
      const body = (await request.json().catch(() => ({}))) as { storagePath?: string; distributorCode?: string; period?: string };
      distributorCode = String(body?.distributorCode ?? "").trim();
      period = String(body?.period ?? "").trim();
      const storagePath = String(body?.storagePath ?? "").trim();
      if (!storagePath) {
        return NextResponse.json({ success: false, error: "Uploaded file reference is missing." }, { status: 400 });
      }
      // Only the caller's own upload slot, checked before it is downloaded or queued for the finally
      // block's delete: both run with the service-role client, so an unchecked path let any importer
      // read, and then erase, another importer's workbook.
      if (!isOwnSalesImportUploadPath({ caller: access, storagePath })) {
        return NextResponse.json({ success: false, ...SALES_UPLOAD_PATH_REFUSAL }, { status: 400 });
      }
      cleanupStoragePath = storagePath;
      file = await downloadSalesUploadFile(storagePath);
      if (!file) {
        return NextResponse.json(
          { success: false, error: "Uploaded workbook was not found in storage. Please re-upload." },
          { status: 400 },
        );
      }
    } else {
      // Small-file path (unchanged): the workbook arrives directly in the multipart body.
      const formData = await request.formData();
      const formFile = formData.get("file");
      file = formFile instanceof File ? formFile : null;
      distributorCode = String(formData.get("distributorCode") ?? "").trim();
      period = String(formData.get("period") ?? "").trim();
    }

    if (!file) {
      return NextResponse.json({ success: false, error: "Sales workbook file is required." }, { status: 400 });
    }
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    }

    const fileValidation = validateSpreadsheetFile(file, {
      ...salesSpreadsheetValidation,
      emptyError: "invalid_sales_file",
      emptyMessage: "Sales workbook is empty.",
      tooLargeError: "sales_file_too_large",
      // The bucket path exists for files over 4 MB, so it is held to the bucket's limit (audit F-06).
      maxBytes: spreadsheetUploadLimitBytes(cleanupStoragePath !== null),
      tooLargeMessage: spreadsheetTooLargeMessage("Sales workbook", spreadsheetUploadLimitBytes(cleanupStoragePath !== null)),
      unsupportedError: "unsupported_sales_file_type",
      unsupportedMessage: "Upload a distributor monthly sales sheet in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { success: false, error: fileValidation.message, code: fileValidation.error },
        { status: fileValidation.status },
      );
    }

    const uploadedBy = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importSourceOfSalesFile({ distributorCode, file, uploadedBy, periodOverride: period, dryRun: true });
    const blocked = result.status === "blocked";

    return NextResponse.json(
      {
        success: !blocked,
        data: result,
        error: blocked ? "Validation blocked. Fix the failed rows before importing." : undefined,
        message: blocked
          ? "Validation blocked."
          : "Validation passed.",
      },
      { status: blocked ? 400 : 200 },
    );
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
      {
        success: false,
        error: clientSafeErrorMessage(error, "Sales validation failed."),
      },
      { status: 500 },
    );
  } finally {
    await removeSalesUploadObject(cleanupStoragePath);
  }
}
