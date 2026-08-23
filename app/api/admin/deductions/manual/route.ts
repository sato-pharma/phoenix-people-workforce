import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { buildManualDeductionDraft } from "@/lib/deductions/connectors/manual.ts";
import { assertDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { isFinalSettlementMonth } from "@/lib/deductions/settlement.ts";
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
    // Month/year were previously passed straight to Number() unchecked, so an
    // absent month produced a NaN monthKey ("2026-NaN"). They now also decide
    // whether a leaver may be settled, so they have to be real first.
    const month = Number(body.month);
    const year = Number(body.year);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("Validation: month must be a whole number between 1 and 12.");
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error("Validation: year must be a four-digit year.");
    }

    // Base salary and name are read SERVER-side from the employees table, never
    // taken from the request. The amount a manual day costs is payroll, so it is
    // derived here from the record of truth; and the name is resolved so the row
    // can never fall back to displaying an HR code.
    const { data: employeeRow, error: employeeError } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, full_name, base_salary, employment_status, last_working_date")
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
      last_working_date: string | null;
    };
    // A person who has LEFT cannot be given a NEW deduction — the picker hides
    // terminal staff, and the write refuses them independently so a stale form,
    // a cached name, or a hand-crafted request can't book one either.
    //
    // The ONE exception is their own final settlement. Blanket-refusing every
    // terminal employee also blocked the last month they actually worked, so
    // the moment HR marked someone resigned their August became unrecordable by
    // any route: collection refuses an unfinished month, and this refused them.
    // All 13 of August 2026's leavers sat in exactly that gap. Settling the
    // month someone left in is not a new charge against someone who is gone.
    if (isTerminalEmploymentStatus(employee.employment_status)) {
      const settling = isFinalSettlementMonth({
        lastWorkingDate: employee.last_working_date,
        month,
        year,
      });
      if (!settling) {
        throw new Error(
          `Validation: ${employee.full_name ?? employee.hr_id} is no longer an active employee (status: ${employee.employment_status}); a deduction can only be recorded for ${employee.last_working_date ? `their final month (${employee.last_working_date})` : "a month they worked, and no last working date is recorded for them"}.`,
        );
      }
    }

    const draft = buildManualDeductionDraft({
      category: body.category,
      employeeHrId: employee.hr_id,
      employeeName: employee.full_name,
      month,
      year,
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
