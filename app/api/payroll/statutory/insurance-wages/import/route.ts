import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAccessContext } from "@/lib/auth/server";
import { parseFormBody } from "@/lib/http/request-body";
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
 * The Insurance Wages screen sends `file`, plus `commit` = "true" only when applying. The file stays
 * optional so a form with none still gets the route's own "An insurance-wage file is required." answer.
 */
const InsuranceWageImportFormSchema = z.object({
  file: z.instanceof(File).optional(),
  commit: z.string().optional(),
});

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

    const form = await parseFormBody(request, InsuranceWageImportFormSchema);
    if (!form.ok) {
      return NextResponse.json({ error: "invalid_request", message: form.message }, { status: 400 });
    }
    const file = form.data.file;
    const commit = form.data.commit === "true";

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
