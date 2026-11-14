import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError, isPostgresUniqueViolation } from "@/lib/sales/contracts";
import { formFiles, formUndatedPeriod, recognizeWorkbookFiles } from "@/lib/sales/normalizer/multi-file";
import { persistNormalizedBatch, recognitionErrorMessage } from "@/lib/sales/normalizer/service";
import { combinedFileName } from "@/lib/sales/sales-upload-files";
import { digestsOfNamedFiles, uploadFingerprint, uploadPartQualifier } from "@/lib/sales/upload-fingerprint";
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
    const { parts } = normalized;
    const coded = parts.reduce((n, part) => n + part.result.coded.length, 0);
    if (coded === 0) {
      return NextResponse.json({ success: false, error: "Nothing to import — no rows could be coded. Map the exceptions first." }, { status: 400 });
    }
    // One batch per distributor and month — a batch is one distributor and one month everywhere in
    // the system, so a template naming several is imported as several, never merged into one, and
    // several sheets of one month are imported as ONE batch rather than one superseding the next.
    const batches: Array<{ batchId: string; distributorName: string; exceptions: number; importedRows: number; period: string | null }> = [];
    for (const part of parts) {
      if (part.result.coded.length === 0) continue;
      const persisted = await persistNormalizedBatch({
        // RESOLVED, never the posted code: a Phoenix-template upload posts a sentinel and the sheet
        // names the real distributor. Filing the batch under the sentinel would invent a distributor.
        distributorCode: part.distributorCode,
        distributorName: part.distributorName,
        // Every sheet the batch was read from ("branch-1.xlsx + branch-2.xlsx"); one sheet keeps its name.
        fileName: combinedFileName(part.fileNames),
        // The part's own month — the month its sheets were read as (each sheet's dominant month).
        period: part.period ?? undefined,
        result: part.result,
        uploadedBy: access.loginId ?? access.hrId ?? "admin",
        // The bytes of the sheets this part was read from (REC-069), told apart from the upload's other parts.
        fileSha256: uploadFingerprint(await digestsOfNamedFiles(files, part.fileNames), uploadPartQualifier(part, parts)),
      });
      batches.push({ ...persisted, distributorName: part.distributorName, exceptions: part.result.exceptions.length });
    }
    return NextResponse.json({
      success: true,
      data: {
        batches,
        batchId: batches[0]?.batchId ?? null,
        exceptions: parts.reduce((n, part) => n + part.result.exceptions.length, 0),
        importedRows: batches.reduce((n, b) => n + b.importedRows, 0),
        period: batches[0]?.period ?? null,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    // A refusal the save step wrote for the user (the same workbook under another period).
    // clientSafeErrorMessage would hide it: a workflow error carrying details reads as
    // infrastructure there, so this sentence would become "Failed to import." behind a 500.
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    // DB backstop (source_of_sales_one_validated_batch_per_period): a validated batch for this
    // distributor + month already exists. Direct import skips the in-app dedup, so surface it clearly
    // instead of a raw 500 — keeps the month from being double-counted in ROI/dashboards.
    if (isPostgresUniqueViolation(error)) {
      return NextResponse.json({ success: false, error: "A validated sheet for this distributor and month is already imported. Delete it on Source of Sales first, then retry." }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to import.") }, { status: 500 });
  }
}
