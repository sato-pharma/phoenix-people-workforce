import { NextResponse } from "next/server";

import { validateSalaryWorkbook } from "@/lib/payroll/salary-import";

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

    return NextResponse.json({
      ...validation,
      payrollPeriod: { month, year },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Salary validation failed.";
    return NextResponse.json({ error: "salary_validation_failed", message }, { status: 500 });
  }
}
