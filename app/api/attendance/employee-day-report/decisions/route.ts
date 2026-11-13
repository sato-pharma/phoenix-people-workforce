import { NextResponse } from "next/server";

import {
  getEmployeeDayDeductionDecisions,
  upsertAndDecideEmployeeDayDeduction,
  type EmployeeDayDecisionInfo,
} from "@/lib/attendance/employee-day-report";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Decide (confirm/reject) a fingerprint deduction directly from the Employee
 * Day-by-Day Report — the standalone Fingerprint Deductions page was retired,
 * this is now the one place that happens (owner direction, 2026-07-24).
 * Same Super Admin gate as the page itself (app/(admin)/attendance/employee-day-report/page.tsx),
 * and the permission matrix's `deductions:approve` asserted beside it — both must pass, for the read
 * as well as the decision, because the read shows the money a decision would apply.
 */
function errorResponse(error: unknown) {
  const message = clientSafeErrorMessage(error, "Unexpected error.");
  const forbidden = message.startsWith("Forbidden:");
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "invalid_request", message },
    { status: forbidden ? 403 : 400 },
  );
}

async function assertSuperAdmin(request: Request) {
  const access = await resolveAccessContext(request);
  if (access.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can review fingerprint deductions here.");
  }
  await assertPermission(access, "deductions", "approve");
  return access;
}

export async function GET(request: Request) {
  try {
    await assertSuperAdmin(request);

    const url = new URL(request.url);
    const employeeHrId = url.searchParams.get("employeeHrId")?.trim() ?? "";
    const dateFrom = url.searchParams.get("dateFrom")?.trim() ?? "";
    const dateTo = url.searchParams.get("dateTo")?.trim() ?? "";
    if (!employeeHrId || !dateFrom || !dateTo) {
      return NextResponse.json(
        { error: "invalid_request", message: "employeeHrId, dateFrom, and dateTo are required." },
        { status: 400 },
      );
    }

    const decisions = await getEmployeeDayDeductionDecisions({
      employeeHrId,
      dateFromIso: dateFrom,
      dateToIso: dateTo,
    });

    return NextResponse.json({ decisions: Object.fromEntries(decisions) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await assertSuperAdmin(request);

    const body = (await request.json().catch(() => ({}))) as {
      employeeHrId?: string;
      dateIso?: string;
      decisionStatus?: string;
      days?: number;
    };
    const employeeHrId = String(body.employeeHrId ?? "").trim();
    const dateIso = String(body.dateIso ?? "").trim();
    if (!employeeHrId || !dateIso) {
      return NextResponse.json(
        { error: "invalid_request", message: "employeeHrId and dateIso are required." },
        { status: 400 },
      );
    }
    if (body.decisionStatus !== "Approved for Payroll" && body.decisionStatus !== "Do Not Take Action") {
      return NextResponse.json(
        { error: "invalid_request", message: "decisionStatus must be 'Approved for Payroll' or 'Do Not Take Action'." },
        { status: 400 },
      );
    }

    const decision = await upsertAndDecideEmployeeDayDeduction({
      employeeHrId,
      dateIso,
      decisionStatus: body.decisionStatus,
      days: typeof body.days === "number" ? body.days : 0,
      actor: access,
    });

    // Return the report's own decision shape (the same EmployeeDayDecisionInfo the GET
    // endpoint returns), not the raw unified DeductionsDecision — the client's optimistic
    // update reads appliedDeductionValue, and both endpoints must speak one contract.
    const decisionInfo: EmployeeDayDecisionInfo = {
      candidateId: decision.candidateId,
      decisionStatus: decision.decisionStatus,
      appliedDeductionValue: decision.appliedValue,
      appliedAmount: decision.appliedAmount,
    };
    // Saved, but payroll could not follow it (Part 2 confirmed, or the resync failed) — the
    // page must say so, or a frozen payroll figure reads as applied.
    return NextResponse.json({ decision: decisionInfo, payrollNotices: decision.payrollNotices });
  } catch (error) {
    return errorResponse(error);
  }
}
