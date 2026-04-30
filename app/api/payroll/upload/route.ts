import { NextResponse } from "next/server";

import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { validateSalaryWorkbook } from "@/lib/payroll/salary-import";
import { createSalaryBatch, isPayrollSchemaMissing } from "@/lib/payroll/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const month = Number(formData.get("month"));
    const year = Number(formData.get("year"));

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file", message: "Salary file is required." }, { status: 400 });
    }

    if (!month || !year) {
      return NextResponse.json(
        { error: "missing_payroll_period", message: "Payroll month and year are required." },
        { status: 400 },
      );
    }

    const validation = await validateSalaryWorkbook(file);

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

    const result = await createSalaryBatch({
      fileName: file.name,
      month,
      records: validation.rowsToImport,
      validationWarnings: validation.validationWarnings,
      year,
    });

    await safeSendNotificationEmail({
      ctaHref: `/payroll?batchId=${result.batch.id}`,
      ctaLabel: "Open payroll dashboard",
      metrics: [
        { label: "Payroll period", value: `${month}/${year}` },
        { label: "Imported salary records", value: result.importedRecords },
        { label: "Governance warnings", value: result.governanceWarnings },
        { label: "Source file", value: file.name },
      ],
      subject: `Phoenix Payroll upload imported - ${month}/${year}`,
      summary: "A payroll salary upload was validated and imported successfully. Review governance warnings before approval.",
      title: "Payroll Upload Imported",
      tone: result.governanceWarnings > 0 ? "warning" : "success",
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll upload failed.";
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
