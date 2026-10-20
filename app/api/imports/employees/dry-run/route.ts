import { NextResponse } from "next/server";

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import { assertPermission, canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadEmployeeImportExistingState } from "@/lib/imports/employee-import-existing-state";
import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import { salaryBlindImportRefusal } from "@/lib/imports/employee-import-salary-blind";
import type {
  EmployeeImportDryRunResponse,
  EmployeeImportRecord,
  RawEmployeeImportRow,
} from "@/lib/imports/employee-import-types";
import { loadSocialInsuranceJobTitles } from "@/lib/hiring-pack/social-insurance-job-title";
import { parseEmployeeUploadRows } from "@/lib/imports/employee-upload-parse";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The insurance job title each matched row would overwrite, so the change preview can show it.
 *
 * SCOPED TO THE ROWS IN THE FILE, and only those that carry a title — a sheet that leaves the
 * column blank changes nothing there and pays for no lookup at all. Keyed lower-case, matching how
 * the preview resolves its employees.
 *
 * RETURNS UNDEFINED ON FAILURE, never an empty object. The two read differently downstream: absent
 * means "not loaded, leave the row out of the diff", while empty means "loaded, nobody has one" —
 * and reporting an unknown as blank would show every filled cell as a change from nothing.
 */
async function loadInsuranceTitlesForPreview(records: EmployeeImportRecord[]) {
  const hrIds = Array.from(
    new Set(
      records
        .filter((record) => record.hrId && record.socialInsuranceJobTitle)
        .map((record) => record.hrId as string),
    ),
  );
  if (hrIds.length === 0) return undefined;

  try {
    const titles = await loadSocialInsuranceJobTitles(hrIds);
    const out: Record<string, string | null> = {};
    for (const hrId of hrIds) out[hrId.trim().toLowerCase()] = titles.get(hrId) ?? null;
    return out;
  } catch {
    // The preview is an aid, not the gate — a satellite table being unavailable must not turn a
    // readable dry run into a failed upload.
    return undefined;
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // Deliberately the `employees` resource, not `imports` — this mutates employee
    // records and Super Admin/Talent Acquisition are the only roles that can reach
    // this page at all. `imports` gates the unrelated /api/admin/users/bulk instead.
    await assertPermission(access, "employees", "import");

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_excel_file",
      emptyMessage: "Employee import file is empty.",
      tooLargeError: "employee_import_file_too_large",
      tooLargeMessage: "Employee import file exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload an employee import Excel file in .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json({ error: fileValidation.error, message: fileValidation.message }, { status: fileValidation.status });
    }

    const parsed = await parseEmployeeUploadRows<RawEmployeeImportRow>(file);

    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // The seat that never sees a salary (employee-import-salary-blind.ts): a file carrying a figure
    // is refused whole, naming its columns, before anything is planned. Both flags come from the
    // server's access context, never from the request.
    const salaryBlind = isSalaryBlindRole(access.role);
    if (salaryBlind) {
      const refusal = salaryBlindImportRefusal(parsed.rows);
      if (refusal) return NextResponse.json(refusal, { status: 400 });
    }
    const allowNewEmployees = await canAccess(access, "employees", "create");

    const existingState = await loadEmployeeImportExistingState();

    const plan = createEmployeeImportPlan(parsed.rows, {
      allowNewEmployees,
      existingState,
      firstDataRowNumber: parsed.firstDataRowNumber,
      salaryBlind,
    });

    const response: EmployeeImportDryRunResponse = {
      ...plan,
      socialInsuranceJobTitles: await loadInsuranceTitlesForPreview(plan.rowsToUpdate ?? []),
    };

    return NextResponse.json(response);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to import employees." }, { status: 403 });
    }

    const message = clientSafeErrorMessage(error, "Employee import dry run failed.");
    return NextResponse.json({ error: "employee_import_dry_run_failed", message }, { status: 500 });
  }
}
