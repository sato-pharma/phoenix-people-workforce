import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  loadTargetValidationRefs,
  upsertMonthlyTargets,
  validateTargetRows,
} from "@/lib/sales/monthly-targets";
import { parseTargetsWorkbook } from "@/lib/sales/targets-template";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sales/targets/upload  (multipart)
//   file    — filled targets workbook (.xlsx)
//   commit  — "true" to persist; otherwise a dry-run preview (validate only, no write)
// Every row is map-or-reject validated against the 42 canonical areas + real products +
// target-bearing areas; unresolved rows are rejected and reported, never auto-created.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    const file = form.get("file");
    const commit = String(form.get("commit") ?? "") === "true";
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "A .xlsx file is required." }, { status: 400 });
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_targets_file", emptyMessage: "The sheet is empty.",
      tooLargeError: "targets_file_too_large", tooLargeMessage: "The sheet exceeds the upload limit.",
      unsupportedError: "unsupported_targets_file_type", unsupportedMessage: "Upload the targets sheet in .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });
    }

    const buffer = await file.arrayBuffer();
    const rows = await parseTargetsWorkbook(buffer);
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: "No target rows found. Check the header row (Period, Line, Area Code, Product Code, Target Value)." }, { status: 422 });
    }

    if (!commit) {
      const refs = await loadTargetValidationRefs();
      const { valid, errors } = validateTargetRows(rows, refs);
      return NextResponse.json({ success: true, mode: "preview", totalRows: rows.length, validRows: valid.length, errors });
    }

    const { upserted, errors } = await upsertMonthlyTargets({
      rows,
      actorHrId: access.hrId ?? access.loginId ?? null,
      source: "upload",
    });
    return NextResponse.json({ success: true, mode: "commit", totalRows: rows.length, upserted, errors });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to process the targets sheet." }, { status: 500 });
  }
}
