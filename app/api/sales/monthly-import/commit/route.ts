import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { saveCoverageSnapshot } from "@/lib/sales/import-coverage";
import { assertNotADuplicateUpload } from "@/lib/sales/import-duplicate-guard";
import { removeSalesUploadObject, resolveSalesUploadRequest } from "@/lib/sales/monthly-import-request";
import { importSourceOfSalesFile } from "@/lib/sales/source-of-sales-upload";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Confirm step of the mandatory preview → confirm flow: persists the upload the user just previewed.
// On the large-file path the Storage object (kept by /preview) is deleted once processing finishes, so
// the bucket only ever holds in-flight uploads.
export async function POST(request: Request) {
  let cleanupStoragePath: string | null = null;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const resolved = await resolveSalesUploadRequest(request);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error, success: false, ...(resolved.code ? { code: resolved.code } : {}) }, { status: resolved.status });
    }
    cleanupStoragePath = resolved.storagePath;

    // Refuse a workbook that has already been committed for this distributor under a DIFFERENT
    // period. IS-S loaded the identical file as both 2026-04 and 2026-05 — 1,141 rows and
    // 349,266.46 EGP each — so one month is double-counted and the other was never loaded.
    // This is the confirm step and `resolved.period` is the period the user actually chose, which
    // is why the check belongs here: earlier in the pipeline the period is not yet known, and a
    // null period would make the legitimate same-period replace flow look like a duplicate.
    await assertNotADuplicateUpload({
      distributorCode: resolved.distributorCode,
      fileName: resolved.file.name,
      period: resolved.period,
    });

    const uploadedBy = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importSourceOfSalesFile({
      distributorCode: resolved.distributorCode,
      dryRun: false,
      file: resolved.file,
      periodOverride: resolved.period,
      uploadedBy,
    });
    const blocked = result.status === "blocked";

    // Persist a coverage snapshot for every non-blocked commit so the Coverage tab can show trend data.
    // The previewDiff is the one the user already reviewed in the modal (sent back in the JSON body).
    // Non-fatal: a snapshot failure must never block a successful import.
    if (!blocked && result.batchId && resolved.previewDiff) {
      void saveCoverageSnapshot({
        batchId: result.batchId,
        details: resolved.unmappedCustomers.map((u) => ({ address: u.address, code: u.customerCode, name: u.customerName })),
        diff: resolved.previewDiff,
        distributorCode: resolved.distributorCode,
        period: result.period ?? null,
      });
    }

    return NextResponse.json(
      {
        data: result,
        error: blocked ? "Import blocked. Fix the unmapped rows before importing." : undefined,
        message: blocked ? "Import blocked." : "Import complete.",
        success: !blocked,
      },
      { status: blocked ? 400 : 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden."), success: false }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ code: error.code, details: error.details, error: error.message, success: false }, { status: error.status });
    }
    return NextResponse.json({ error: clientSafeErrorMessage(error, "Sales import failed."), success: false }, { status: 500 });
  } finally {
    await removeSalesUploadObject(cleanupStoragePath);
  }
}
