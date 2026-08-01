import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { buildManualDeductionDraft } from "@/lib/deductions/connectors/manual.ts";
import { assertDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { insertCandidateDrafts } from "@/lib/deductions/service.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

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

    const draft = buildManualDeductionDraft({
      category: body.category,
      employeeHrId: body.employeeHrId,
      employeeName: typeof body.employeeName === "string" ? body.employeeName : null,
      month: Number(body.month),
      year: Number(body.year),
      unit: body.unit,
      value: Number(body.value),
      reason: typeof body.reason === "string" ? body.reason : "",
      enteredBy: access.hrId ?? access.loginId ?? "unknown",
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
