import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { formFiles, formUndatedPeriod, recognizeWorkbookFiles } from "@/lib/sales/normalizer/multi-file";
import { recognitionErrorMessage, summarizePreview } from "@/lib/sales/normalizer/service";
import { labelPreviewRows } from "@/lib/sales/sales-upload-files";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: Source Normalizer is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    // One raw sheet, or several of the same distributor chosen together (multi-file.ts).
    const files = formFiles(form);
    const distributorCode = String(form.get("distributorCode") ?? "");
    if (files.length === 0) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });

    const normalized = await recognizeWorkbookFiles(distributorCode, files, { undatedPeriod: formUndatedPeriod(form) });
    if (normalized.status !== "ok") {
      return NextResponse.json({ success: false, error: recognitionErrorMessage(normalized) }, { status: 422 });
    }
    // ONE PREVIEW PER DISTRIBUTOR AND MONTH, and each carries the RESOLVED distributor rather than the
    // code the form sent: a Phoenix-template upload arrives under a sentinel and the sheet names its own
    // distributors — one, or as many as the person put in it. Every mapping saved off a preview is
    // filed under that preview's `distributorCode`, so a customer code from one distributor can never
    // be learned against another. A distributor's own export always answers with exactly one part;
    // several of its sheets answer with one part per month, each sheet's rows named by its file.
    const parts = normalized.parts.map((part) => ({
      ...labelPreviewRows(summarizePreview(part.distributorCode, part.distributorName, part.result, normalized.products), normalized.fileNames),
      ...(normalized.fileNames.length > 1 ? { fileNames: part.fileNames } : {}),
    }));
    return NextResponse.json({ success: true, data: { parts } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    // A refusal written for the user (too many files, the same sheet twice). clientSafeErrorMessage
    // would hide it behind "Failed to normalize file.".
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to normalize file.") }, { status: 500 });
  }
}
