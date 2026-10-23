import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { assertCopilotAccess, copilotErrorResponse } from "@/lib/payroll/copilot/access";
import { getStatutoryConfigForPeriod } from "@/lib/payroll/statutory/config";
import {
  applyInsuranceWages,
  parseInsuranceWageWorkbook,
  previewInsuranceWages,
} from "@/lib/payroll/statutory/insurance-wage-import";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { excelSpreadsheetValidation, spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bulk-set employees.social_insurance_wage from an xlsx (HR_ID + Insurance Wage).
 * With commit != "true" it returns a preview (matched / unmatched / issues);
 * with commit === "true" it applies the matched rows. CEO + Super Admin only.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);

    const formData = await request.formData();
    const file = formData.get("file");
    const commit = String(formData.get("commit") ?? "") === "true";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file", message: "An insurance-wage file is required." }, { status: 400 });
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...excelSpreadsheetValidation,
      emptyError: "invalid_wage_file",
      emptyMessage: "The insurance-wage file is empty.",
      tooLargeError: "wage_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("The insurance-wage file"),
      unsupportedError: "unsupported_wage_file_type",
      unsupportedMessage: "Upload an Excel file (.xls or .xlsx) with HR_ID and Insurance Wage columns.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json({ error: fileValidation.error, message: fileValidation.message }, { status: fileValidation.status });
    }

    const buffer = await file.arrayBuffer();
    // The legal band in force this month, Cairo time: the same effective-dated row the statutory
    // engine reads, so an import can never store a wage the filing would quietly clamp (audit finding 41).
    const { year, month } = currentCairoDateParts();
    const band = await getStatutoryConfigForPeriod({ month, year });
    const parsed = await parseInsuranceWageWorkbook(buffer, band);
    const preview = await previewInsuranceWages(parsed.rows);

    if (!commit) {
      return NextResponse.json({
        committed: false,
        issues: parsed.issues,
        detected: parsed.detected,
        matchedCount: preview.matched.length,
        unmatchedCount: preview.unmatched.length,
        unmatched: preview.unmatched.slice(0, 50),
        sample: preview.matched.slice(0, 10),
      });
    }

    if (preview.matched.length === 0) {
      return NextResponse.json(
        { error: "no_matches", message: "No rows matched an existing employee HR_ID.", unmatched: preview.unmatched.slice(0, 50) },
        { status: 400 },
      );
    }

    const result = await applyInsuranceWages(preview.matched);
    return NextResponse.json({
      committed: true,
      updated: result.updated,
      failed: result.failed,
      matchedCount: preview.matched.length,
      unmatchedCount: preview.unmatched.length,
      unmatched: preview.unmatched.slice(0, 50),
      issues: parsed.issues,
    });
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
