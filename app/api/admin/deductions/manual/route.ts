import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { buildManualDeductionDraft } from "@/lib/deductions/connectors/manual.ts";
import { assertDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { insertCandidateDrafts } from "@/lib/deductions/service.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManualEntryBody = {
  category?: unknown;
  employeeHrId?: unknown;
  employeeName?: unknown;
  month?: unknown;
  year?: unknown;
  unit?: unknown;
  value?: unknown;
  reason?: unknown;
};

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "create");
    assertDeductionsDecisionActor(access);

    const body = (await request.json()) as ManualEntryBody;
    if (body.category !== "loan" && body.category !== "other") {
      throw new Error('Validation: category must be "loan" or "other".');
    }
    if (typeof body.employeeHrId !== "string" || !body.employeeHrId.trim()) {
      throw new Error("Validation: employeeHrId is required.");
    }
    if (body.unit !== "days" && body.unit !== "amount") {
      throw new Error('Validation: unit must be "days" or "amount".');
    }

    // Base salary and name are read SERVER-side from the employees table, never
    // taken from the request. The amount a manual day costs is payroll, so it is
    // derived here from the record of truth; and the name is resolved so the row
    // can never fall back to displaying an HR code.
    const { data: employeeRow, error: employeeError } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, full_name, base_salary, employment_status")
      .eq("hr_id", body.employeeHrId.trim())
      .maybeSingle();
    if (employeeError) {
      throw new Error(`Employee lookup failed: ${employeeError.message}`);
    }
    if (!employeeRow) {
      throw new Error("Not found: no employee matches that record.");
    }
    const employee = employeeRow as {
      hr_id: string;
      full_name: string | null;
      base_salary: number | null;
      employment_status: string | null;
    };
    // A person who has LEFT the company cannot be given a new deduction. The picker
    // now hides terminal staff, but the write must refuse them independently so a
    // stale form, a cached name, or a hand-crafted request can't book one either.
    if (isTerminalEmploymentStatus(employee.employment_status)) {
      throw new Error(
        `Validation: ${employee.full_name ?? employee.hr_id} is no longer an active employee (status: ${employee.employment_status}); a deduction cannot be recorded.`,
      );
    }

    const draft = buildManualDeductionDraft({
      category: body.category,
      employeeHrId: employee.hr_id,
      employeeName: employee.full_name,
      month: Number(body.month),
      year: Number(body.year),
      unit: body.unit,
      value: Number(body.value),
      reason: typeof body.reason === "string" ? body.reason : "",
      enteredBy: access.hrId ?? access.loginId ?? "unknown",
      baseSalary: employee.base_salary,
    });

    const result = await insertCandidateDrafts({
      createdBy: access.hrId ?? access.loginId ?? "unknown",
      drafts: [draft],
      sourceLabel: `Manual ${body.category} entry`,
      autoDecideStatus: "Approved for Payroll",
      autoDecideReason: "Manually entered by HR",
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    return jsonError(error, "Failed to record the manual deduction entry.");
  }
}
