import { hrIdForStorage } from "@/lib/hr-id";
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { payrollBatchHref, payrollBatchNotificationMetadata } from "@/lib/payroll/links";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import { validateSalaryWorkbook } from "@/lib/payroll/salary-import";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import {
  createSalaryBatch,
  findSalaryBatchForPeriod,
  isPayrollSchemaMissing,
  payrollPeriodConflictForBatch,
} from "@/lib/payroll/service";
import { upsertPayrollResignationCandidates } from "@/lib/resignations/service";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { excelSpreadsheetValidation, spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payrollPeriodConflictResponse(conflict: ReturnType<typeof payrollPeriodConflictForBatch>) {
  return NextResponse.json(
    {
      conflict,
      error: conflict.replaceable ? "payroll_period_conflict" : "payroll_period_closed",
      message: conflict.message,
    },
    { status: 409 },
  );
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "payroll", "import");
    const formData = await request.formData();
    const file = formData.get("file");
    const rawMonth = formData.get("month");
    const rawYear = formData.get("year");
    const month = Number(rawMonth);
    const year = Number(rawYear);

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file", message: "Salary file is required." }, { status: 400 });
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...excelSpreadsheetValidation,
      emptyError: "invalid_salary_file",
      emptyMessage: "Salary file is empty.",
      tooLargeError: "salary_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("Salary file"),
      unsupportedError: "unsupported_salary_file_type",
      unsupportedMessage: "Upload an Excel salary file in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { error: fileValidation.error, message: fileValidation.message },
        { status: fileValidation.status },
      );
    }

    if (!rawMonth || !rawYear) {
      return NextResponse.json(
        { error: "missing_payroll_period", message: "Payroll month and year are required." },
        { status: 400 },
      );
    }

    try {
      assertValidPayrollPeriod(month, year);
    } catch (error) {
      return NextResponse.json(
        {
          error: "invalid_payroll_period",
          message: clientSafeErrorMessage(error, "Payroll period is invalid."),
        },
        { status: 400 },
      );
    }

    const existingBatch = await findSalaryBatchForPeriod(month, year);
    if (existingBatch) {
      return payrollPeriodConflictResponse(payrollPeriodConflictForBatch(existingBatch));
    }

    const salarySources = await getPayrollSalarySourcesByHrId({ month, year });
    const validation = await validateSalaryWorkbook(file, {
      expectedPeriod: { month, year },
      salarySources,
    });
    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    await upsertPayrollResignationCandidates({
      actor,
      candidates: validation.payrollResignationCandidates,
      month,
      sourceFileName: file.name,
      year,
    });

    if (
      validation.failedRows > 0 ||
      validation.missingRequiredColumns.length > 0 ||
      validation.duplicateHrIds.length > 0
    ) {
      return NextResponse.json(
        {
          error: "salary_validation_failed",
          message: "Fix blocking validation errors before confirming the upload.",
          validation,
        },
        { status: 400 },
      );
    }

    if (validation.rowsToImport.length === 0) {
      return NextResponse.json(
        {
          error: "empty_salary_upload",
          message: "Salary upload file must include at least one salary row.",
          validation,
        },
        { status: 400 },
      );
    }

    const payrollGovernanceWarnings = validation.validationWarnings.filter(
      (warning) => warning.code !== "employee_not_found",
    );

    const fileBuffer = await file.arrayBuffer();
    const fileContentHash = createHash("sha256")
      .update(new Uint8Array(fileBuffer))
      .digest("hex");

    const result = await createSalaryBatch({
      fileContentHash,
      fileName: file.name,
      month,
      records: validation.rowsToImport,
      uploadedBy: actor,
      validationWarnings: payrollGovernanceWarnings,
      year,
    });

    const batchHref = payrollBatchHref(result.batch.id);
    // "salary_upload_imported" is an ops event about a BATCH, not a specific employee — there
    // is no subject to resolve permission_based against (permissionBasedRecipients bails on
    // `if (!subject) continue` before it reaches the company/system-scope bypass), so this
    // reached nobody in production (1 event, NULL employee_hr_id, 2026-07-13). Name the
    // audience explicitly via the admin-editable payroll_workflow_alert role policy — owner
    // decision 2026-08-09: Super Admin, CEO, Finance Manager. Each still has to pass
    // canAccess(context, "payroll", "read") individually.
    const { recipients: alertRecipients, warnings: alertWarnings } =
      await resolveNotificationPersonRecipients("payroll_workflow_alert", "Payroll upload alert recipients");
    if (alertWarnings.length > 0) {
      logError("Payroll upload alert recipient resolution warned", {
        labels: { event: "payroll_upload_alert_recipients_warning", batch_id: String(result.batch.id) },
        error: new Error(alertWarnings.join("; ")),
      });
    }
    const moduleOwnerHrIds = alertRecipients.map((recipient) => recipient.hrId).filter(Boolean);
    await createSystemNotification({
      actionUrl: batchHref,
      actorId: actor,
      email: {
        ctaHref: batchHref,
        ctaLabel: "Open payroll dashboard",
        metrics: [
          { label: "Payroll period", value: `${month}/${year}` },
          { label: "Imported salary records", value: result.importedRecords },
          { label: "Governance warnings", value: result.governanceWarnings },
          { label: "Source file", value: file.name },
        ],
        notificationType: "general",
        subject: `Phoenix Payroll upload imported - ${month}/${year}`,
        summary: "A payroll salary upload was validated and imported successfully. Review governance warnings before approval.",
        // Explicit context so {{status}} in the payroll_update template renders cleanly
        // instead of the generic "Label: value | Label: value | ..." metric dump.
        templateContext: {
          status: result.governanceWarnings > 0
            ? `Imported with ${result.governanceWarnings} governance warning(s) (${month}/${year})`
            : `Imported cleanly, no governance warnings (${month}/${year})`,
        },
        title: "Payroll Upload Imported",
        tone: result.governanceWarnings > 0 ? "warning" : "success",
      },
      eventType: "salary_upload_imported",
      message: "A payroll salary upload was validated and imported successfully.",
      metadata: {
        ...payrollBatchNotificationMetadata(result.batch.id),
        governanceWarnings: result.governanceWarnings,
        idempotencyKey: `payroll-upload:${result.batch.id}`,
        moduleOwnerHrIds,
        sensitivity: "payroll",
      },
      module: "payroll",
      priority: result.governanceWarnings > 0 ? "critical" : "high",
      recordId: String(result.batch.id),
      title: "Payroll Upload Imported",
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Payroll upload failed.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    if (isPayrollConflictError(error)) {
      return NextResponse.json({ error: "payroll_period_conflict", message }, { status: 409 });
    }
    const schemaMissing = isPayrollSchemaMissing(error);

    return NextResponse.json(
      {
        error: schemaMissing ? "payroll_schema_not_ready" : "payroll_upload_failed",
        message,
      },
      { status: schemaMissing ? 503 : 500 },
    );
  }
}
