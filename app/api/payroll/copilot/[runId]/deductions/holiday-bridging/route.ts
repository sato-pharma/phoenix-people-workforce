import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
import { compactHrKey } from "@/lib/payroll/copilot/feeders";
import {
  listHolidayBridgingCandidates,
  recordHolidayBridgingDecision,
} from "@/lib/payroll/copilot/holiday-bridging";
import {
  buildHolidayBridgingReportWorkbook,
  formatPeriodLabel,
  getHireDateMap,
  periodFileSlug,
  xlsxResponse,
} from "@/lib/payroll/copilot/report-exports";
import { getRunPeriod } from "@/lib/payroll/copilot/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);
    const { runId } = await params;
    const period = await getRunPeriod(runId);
    const candidates = await listHolidayBridgingCandidates(period);
    const hireDates = await getHireDateMap();

    if (new URL(request.url).searchParams.get("format") === "xlsx") {
      const buffer = await buildHolidayBridgingReportWorkbook({
        periodLabel: formatPeriodLabel(period),
        rows: candidates,
        hireDates,
      });
      return xlsxResponse(buffer, `Holiday_Bridging_Deductions_${periodFileSlug(period)}.xlsx`);
    }

    return NextResponse.json({
      autoAppliesUnlessExcluded: true,
      candidates: candidates.map((c) => ({
        id: c.id,
        employeeHrId: c.employeeHrId,
        employeeName: c.employeeName,
        hireDate: hireDates.get(compactHrKey(c.employeeHrId)) ?? null,
        vacationType: c.vacationType,
        bridgingDate: c.bridgingDate,
        adjacentTo: c.adjacentTo,
        holidayName: c.holidayName,
        holidayStartDate: c.holidayStartDate,
        holidayEndDate: c.holidayEndDate,
        salaryDeductionAmount: c.salaryDeductionAmount,
        excluded: c.excluded,
      })),
    });
  } catch (error) {
    return copilotErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);
    const { runId } = await params;

    const body = (await request.json().catch(() => ({}))) as {
      requestId?: string;
      employeeHrId?: string;
      bridgingDate?: string;
      action?: string;
    };

    if (body.action !== "exclude" && body.action !== "include") {
      return NextResponse.json(
        { error: "invalid_request", message: "action must be 'exclude' or 'include'." },
        { status: 400 },
      );
    }
    const requestId = String(body.requestId ?? "").trim();
    const employeeHrId = String(body.employeeHrId ?? "").trim();
    const bridgingDate = String(body.bridgingDate ?? "").trim();
    if (!requestId || !employeeHrId || !bridgingDate) {
      return NextResponse.json(
        { error: "invalid_request", message: "requestId, employeeHrId, and bridgingDate are required." },
        { status: 400 },
      );
    }

    await recordHolidayBridgingDecision({
      runId,
      requestId,
      employeeHrId,
      bridgingDate,
      action: body.action,
      decidedBy: resolveCopilotActor(access),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
