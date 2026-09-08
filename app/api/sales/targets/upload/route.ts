import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  loadMonthlyTargets,
  loadTargetValidationRefs,
  upsertMonthlyTargets,
  validateTargetRows,
} from "@/lib/sales/monthly-targets";
import { parseTargetsWorkbook } from "@/lib/sales/targets-template";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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

    const refs = await loadTargetValidationRefs();
    const { valid, errors } = validateTargetRows(rows, refs);

    // ── Which months is this file about? ────────────────────────────────────
    //
    // A targets workbook carries its own Period column, so the month it writes is whatever is
    // INSIDE the file — never the month on screen. Uploading last quarter's sheet by mistake would
    // overwrite three closed months, and `phx_upsert_monthly_targets` is ON CONFLICT DO UPDATE, so
    // the replaced numbers leave no trace at all (`au.monthly_targets` keeps no history — that is
    // what made 2026-09-08's lost month unrecoverable). The months are therefore reported back
    // before anything is written, and the commit REFUSES unless the caller confirms exactly the
    // set the file actually contains. The guard is here rather than only in the dialog: a
    // confirmation the server does not check is decoration.
    const byPeriod = new Map<string, { period: string; lineCode: string; rows: number }>();
    for (const row of valid) {
      const key = `${row.period}|${row.line_code}`;
      const entry = byPeriod.get(key) ?? { period: row.period, lineCode: row.line_code, rows: 0 };
      entry.rows += 1;
      byPeriod.set(key, entry);
    }
    const periods = [...byPeriod.values()].sort(
      (left, right) => left.period.localeCompare(right.period) || left.lineCode.localeCompare(right.lineCode),
    );
    const periodKeys = [...new Set(periods.map((entry) => entry.period))].sort();

    // How many of those cells already carry a target, so the confirmation can say what is being
    // REPLACED rather than only what is being added.
    const overwritesByKey = new Map<string, number>();
    await Promise.all(
      periodKeys.map(async (period) => {
        const stored = await loadMonthlyTargets(period);
        const cells = new Set(stored.map((row) => `${row.lineCode}|${row.areaCode}|${row.productCode.toUpperCase()}`));
        for (const row of valid) {
          if (row.period !== period) continue;
          if (!cells.has(`${row.line_code}|${row.area_code}|${row.product_code.toUpperCase()}`)) continue;
          const key = `${row.period}|${row.line_code}`;
          overwritesByKey.set(key, (overwritesByKey.get(key) ?? 0) + 1);
        }
      }),
    );

    const periodSummary = periods.map((entry) => ({
      period: entry.period,
      lineCode: entry.lineCode,
      rows: entry.rows,
      overwrites: overwritesByKey.get(`${entry.period}|${entry.lineCode}`) ?? 0,
    }));

    if (!commit) {
      return NextResponse.json({
        success: true,
        mode: "preview",
        totalRows: rows.length,
        validRows: valid.length,
        periods: periodSummary,
        errors,
      });
    }

    // `confirmPeriods` is what the person was SHOWN and agreed to; it must match the file exactly.
    // A mismatch means the file changed between the check and the save, or the confirmation came
    // from a different file — either way, refuse and say what THIS one holds.
    const confirmed = String(form.get("confirmPeriods") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort();
    const sameSet =
      confirmed.length === periodKeys.length && confirmed.every((value, index) => value === periodKeys[index]);
    if (!sameSet) {
      return NextResponse.json(
        {
          success: false,
          error:
            `This file sets targets for ${periodKeys.length} month(s): ${periodKeys.join(", ")}. `
            + "Check the file again and confirm those months before saving.",
          code: "period_confirmation_required",
          periods: periodSummary,
        },
        { status: 409 },
      );
    }

    const { upserted, errors: writeErrors } = await upsertMonthlyTargets({
      rows,
      actorHrId: access.hrId ?? access.loginId ?? null,
      source: "upload",
    });
    return NextResponse.json({
      success: true,
      mode: "commit",
      totalRows: rows.length,
      upserted,
      periods: periodSummary,
      errors: writeErrors,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to process the targets sheet.") }, { status: 500 });
  }
}
