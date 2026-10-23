import { NextResponse } from "next/server";

import { resolveAccessContext, isForbiddenError } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError, unauthorizedError } from "@/lib/http/api-errors";
import {
  buildBulkImportPreview,
  executeBulkImport,
  generateBulkUploadTemplate,
  parseBulkUploadFile,
} from "@/lib/marketing-requests/bulk-import";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bulkApiError(error: unknown, fallback: string) {
  if (isForbiddenError(error)) return { code: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), status: 403 };
  const apiError = toApiError(error, fallback);
  return { code: apiError.code, message: apiError.message, status: apiError.status };
}

// GET — download the XLSX template
export async function GET(request: Request) {
  try {
    // resolveAccessContext() never throws for a missing/invalid session — it falls back to a
    // valid anonymousAccessContext (source: "guest") instead, so this check must be explicit.
    const access = await resolveAccessContext(request);
    if (access.source === "guest") {
      throw unauthorizedError();
    }
    const buffer = await generateBulkUploadTemplate(access);
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="marketing-requests-bulk-upload-template.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const { code, message, status } = bulkApiError(error, "Failed to generate template.");
    return NextResponse.json({ error: code, message }, { status });
  }
}

// POST — parse + preview or execute
// Accepts multipart/form-data with:
//   file: the XLSX file blob
//   mode: "preview" (default) | "execute"
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    // resolveAccessContext() never throws for a missing/invalid session — it falls back to a
    // valid anonymousAccessContext (source: "guest") instead, so this check must be explicit.
    // (executeBulkImport() separately checks for Super Admin below, but the default/preview
    // path had no gate at all — buildBulkImportPreview() takes no access context and cross-
    // matches uploaded rows against live marketing reference data.)
    const access = await resolveAccessContext(request);
    if (access.source === "guest") {
      throw unauthorizedError();
    }
    const formData = await request.formData();
    const file = formData.get("file");
    const mode = (formData.get("mode") as string | null) ?? "preview";

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: "validation_error", message: "No file uploaded." }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const rows = await parseBulkUploadFile(buffer);

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "validation_error", message: "The uploaded file contains no data rows (rows 3+ after the header and notes rows)." },
        { status: 400 },
      );
    }

    if (mode === "execute") {
      const result = await executeBulkImport(rows, access);
      return NextResponse.json({ result }, { status: 200 });
    }

    // Default: preview — gated on Super Admin inside the service, same as execute.
    const preview = await buildBulkImportPreview(rows, access);
    return NextResponse.json({ preview }, { status: 200 });
  } catch (error) {
    const { code, message, status } = bulkApiError(error, "Bulk upload failed.");
    return NextResponse.json({ error: code, message }, { status });
  }
}
