import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { createSourceOfSalesUploadFromBuffer } from "@/lib/sales/monthly-distributor-import";
import { applyCustomerBrickCorrections } from "@/lib/sales/normalizer/customer-map";
import { describeRefusedRow, isRefusedRow } from "@/lib/sales/normalizer/row-messages";
import { buildCodedParts, learnFromImportHistory } from "@/lib/sales/normalizer/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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

    // One part per distributor in the file. A distributor's own export is always a single part; a
    // Phoenix template is one part per distributor named in it, each filed as its own batch, because
    // a batch is one distributor and one month everywhere else in the system. Each part carries the
    // RESOLVED distributor — the template posts a sentinel and names its distributors inside.
    const parts = await buildCodedParts(distributorCode, file);
    const many = parts.length > 1;
    /** "Ibnsina: " in front of a message, but only when the file holds more than one distributor. */
    const whose = (name: string) => (many ? `${name}: ` : "");

    if (parts.every((part) => part.result.coded.length === 0)) {
      return NextResponse.json({ success: false, error: "Nothing to import — no rows could be coded. Map the exceptions first." }, { status: 400 });
    }
    // The Direct (company) channel takes its value FROM the sheet (no factory recompute), so it uses its
    // own import on Source of Sales. The validated Normalizer path is for distributor sheets only.
    if (parts.some((part) => part.result.coded.some((r) => r.isDirect))) {
      return NextResponse.json({ success: false, error: "Direct channel sheets use the Direct import on Source of Sales (pick 'Direct'). The validated Normalizer import is for distributor sheets." }, { status: 400 });
    }

    // Block if any rows could not be mapped — never silently drop qty. Checked across EVERY
    // distributor before a single one is written: refusing halfway would leave the month imported
    // for some distributors in the file and not for others.
    const failedRows = parts.reduce((n, part) => n + part.result.exceptions.length, 0);
    const refusedRows = parts.reduce((n, part) => n + part.result.exceptions.filter(isRefusedRow).length, 0);
    if (failedRows > 0) {
      const rowLines = parts.flatMap((part) => part.result.exceptions.slice(0, 20).map((exc) => {
        const item = exc.rawProductName || exc.rawProduct || "?";
        const area = exc.rawTerritory || exc.rawCustomerCode || "?";
        // A bad cell or a blank customer is said as it is; it used to read "product and territory not mapped".
        if (isRefusedRow(exc)) return `${whose(part.distributorName)}${describeRefusedRow(exc)}`;
        if (exc.reason === "product") return `${whose(part.distributorName)}Row ${exc.rawRowNumber}: product "${item}" not mapped`;
        if (exc.reason === "brick") return `${whose(part.distributorName)}Row ${exc.rawRowNumber}: territory "${area}" not mapped`;
        return `${whose(part.distributorName)}Row ${exc.rawRowNumber}: product "${item}" and territory "${area}" not mapped`;
      }));
      const more = failedRows > rowLines.length ? ` — and ${failedRows - rowLines.length} more.` : "";
      return NextResponse.json({
        success: false,
        error: refusedRows > 0
          ? `${failedRows} row${failedRows === 1 ? "" : "s"} could not be imported. ${refusedRows} of them ${refusedRows === 1 ? "has" : "have"} a quantity, value or discount the sheet got wrong, or no customer — each is listed; correct those in the distributor's sheet; map any others in the Mapping tab, then re-import.`
          : `${failedRows} row${failedRows === 1 ? "" : "s"} could not be imported — product or territory not mapped. Fix them in the Mapping tab then re-import.`,
        data: {
          blockingReasons: [...rowLines, more].filter(Boolean),
          failedRows,
          importableRows: parts.reduce((n, part) => n + part.result.coded.length, 0),
          status: "blocked",
        },
      }, { status: 400 });
    }

    const batches: Array<{ batchId: string; distributorName: string; importableRows: number; period: string | null; warningRows: number }> = [];
    for (const part of parts) {
      if (part.result.coded.length === 0) continue;
      const persisted = await createSourceOfSalesUploadFromBuffer({
        buffer: part.buffer as ArrayBuffer,
        distributorCode: part.distributorCode,
        // Named per distributor when the file carries several, so the batch record says which slice
        // of the upload it is instead of showing the same file name three times.
        fileName: many ? `${file.name} (${part.distributorName})` : file.name,
        persistOnlyIfValidated: true,
        uploadedBy: access.loginId ?? access.hrId ?? "admin",
      });

      if (!persisted.batchId) {
        // Say plainly what already landed: the parts before this one are real batches on Source of
        // Sales, and calling the whole upload a failure would send him hunting for rows that are there.
        const landed = batches.length > 0
          ? ` ${batches.map((b) => b.distributorName).join(", ")} imported before it and ${batches.length === 1 ? "is" : "are"} on Source of Sales already.`
          : "";
        return NextResponse.json({
          success: false,
          error: `${whose(part.distributorName)}the coded sheet did not pass validation, so nothing was imported for it. Fix the blocking rows (e.g. map the missing bricks) and try again.${landed}`,
          data: { batches, blockingReasons: persisted.blockingReasons, failedRows: persisted.failedRows, status: persisted.status, warningRows: persisted.warningRows },
        }, { status: 400 });
      }

      // Self-heal the customer->brick crosswalk from what this CONFIRMED import's sheet itself
      // resolved — only after persisted.batchId confirms the batch actually validated, never on a
      // blocked/preview result.
      if (part.result.customerBrickCorrections.length > 0) {
        await applyCustomerBrickCorrections(part.result.customerBrickCorrections, { actorLoginId: access.loginId ?? access.hrId ?? "admin" });
      }

      // Fire-and-forget: mine the newly imported rows into the alias dictionary.
      // Errors here are non-fatal — the import already succeeded.
      learnFromImportHistory(part.distributorCode).catch(() => { /* non-fatal */ });

      batches.push({
        batchId: persisted.batchId,
        distributorName: part.distributorName,
        importableRows: persisted.importableRows,
        period: persisted.period,
        warningRows: persisted.warningRows,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        batchId: batches[0]?.batchId ?? null,
        batches,
        exceptions: 0,
        importableRows: batches.reduce((n, b) => n + b.importableRows, 0),
        period: batches[0]?.period ?? null,
        warningRows: batches.reduce((n, b) => n + b.warningRows, 0),
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    // A refusal the save step wrote for the user (the same workbook under another period, a locked
    // period). clientSafeErrorMessage would hide it: a workflow error carrying details reads as
    // infrastructure there, so this sentence would become "Failed to import." behind a 500.
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to import.") }, { status: 500 });
  }
}
