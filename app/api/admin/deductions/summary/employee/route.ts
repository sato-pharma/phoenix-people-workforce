import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { getEmployeeMonthSummary } from "@/lib/deductions/service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    const employeeHrId = url.searchParams.get("employeeHrId");
    if (!monthKey || !employeeHrId) {
      throw new Error("Validation: monthKey and employeeHrId query parameters are required.");
    }

    const summary = await getEmployeeMonthSummary({ monthKey, employeeHrId });
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    return jsonError(error, "Failed to load the employee deduction summary.");
  }
}
