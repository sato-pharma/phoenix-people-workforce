import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importSourceOfSalesFile } from "@/lib/sales/source-of-sales-upload";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { salesSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LARGE_UPLOAD_BUCKET = "sales-imports";

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
      cleanupStoragePath = storagePath;
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.storage.from(LARGE_UPLOAD_BUCKET).download(storagePath);
      if (error || !data) {
        return NextResponse.json(
          { success: false, error: "Uploaded workbook was not found in storage. Please re-upload." },
          { status: 400 },
        );
      }
      const buffer = Buffer.from(await data.arrayBuffer());
      const fileName = storagePath.split("/").pop() ?? "upload.xlsx";
      file = new File([buffer], fileName, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
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
      tooLargeMessage: "Sales workbook exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_sales_file_type",
      unsupportedMessage: "Upload a distributor monthly sales sheet in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { success: false, error: fileValidation.message, code: fileValidation.error },
        { status: fileValidation.status },
      );
    }

    const uploadedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importSourceOfSalesFile({ distributorCode, file, uploadedBy, periodOverride: period });
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
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
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
        error: error instanceof Error ? error.message : "Sales validation failed.",
      },
      { status: 500 },
    );
  } finally {
    if (cleanupStoragePath) {
      await getSupabaseAdmin().storage.from(LARGE_UPLOAD_BUCKET).remove([cleanupStoragePath]).catch(() => {});
    }
  }
}
