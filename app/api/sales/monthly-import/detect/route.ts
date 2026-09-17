import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { detectDistributorFromBuffer } from "@/lib/sales/distributor-detection";
import { downloadSalesUploadObject } from "@/lib/sales/monthly-import-request";
import {
  isOwnSalesImportUploadPath,
  SALES_UPLOAD_PATH_REFUSAL,
  type SalesImportUploadCaller,
} from "@/lib/sales/sales-import-upload-path";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: parse just the header row of the uploaded sheet and return the best-matching
// distributor(s). Used so the upload screen can pre-select the right distributor (and warn on a
// wrong manual pick). Persists nothing. Detection logic is shared via distributor-detection.ts.
// A storage path is read with the service-role client, so it must be the caller's own upload slot.

async function resolveBuffer(
  request: Request,
  caller: SalesImportUploadCaller,
): Promise<{ buffer: ArrayBuffer } | { code?: string; error: string; status: number }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { storagePath?: string };
    const path = String(body?.storagePath ?? "").trim();
    if (!path) return { error: "Uploaded file reference is missing.", status: 400 };
    if (!isOwnSalesImportUploadPath({ caller, storagePath: path })) return { ...SALES_UPLOAD_PATH_REFUSAL, status: 400 };
    const data = await downloadSalesUploadObject(path);
    if (!data) return { error: "Uploaded workbook was not found in storage.", status: 400 };
    return { buffer: await data.arrayBuffer() };
  }
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Sales workbook file is required.", status: 400 };
  return { buffer: await file.arrayBuffer() };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const resolved = await resolveBuffer(request, access);
    if ("error" in resolved) {
      return NextResponse.json(
        { error: resolved.error, success: false, ...(resolved.code ? { code: resolved.code } : {}) },
        { status: resolved.status },
      );
    }

    const detection = await detectDistributorFromBuffer(resolved.buffer);
    return NextResponse.json({ data: detection, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden."), success: false }, { status: 403 });
    }
    return NextResponse.json({ error: clientSafeErrorMessage(error, "Distributor detection failed."), success: false }, { status: 500 });
  }
}
