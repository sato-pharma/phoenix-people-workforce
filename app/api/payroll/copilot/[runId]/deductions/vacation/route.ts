import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
import {
  buildVacationReportWorkbook,
  getHireDateMap,
  periodFileSlug,
  formatPeriodLabel,
  xlsxResponse,
} from "@/lib/payroll/copilot/report-exports";
import { getRunPeriod } from "@/lib/payroll/copilot/service";
import {
  listUnpaidVacationCandidates,
  recordVacationSettlementDecision,
} from "@/lib/payroll/copilot/vacation-settlement";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { VacationType } from "@/lib/vacation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);
    const { runId } = await params;
    const period = await getRunPeriod(runId);
    const candidates = await listUnpaidVacationCandidates(period);

    if (new URL(request.url).searchParams.get("format") === "xlsx") {
      const buffer = await buildVacationReportWorkbook({
        periodLabel: formatPeriodLabel(period),
        rows: candidates,
        hireDates: await getHireDateMap(),
      });
      return xlsxResponse(buffer, `Unpaid_Vacation_${periodFileSlug(period)}.xlsx`);
    }

    return NextResponse.json({ candidates });
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
      startDate?: string;
      endDate?: string;
      unpaidDays?: number;
      vacationType?: string;
      salaryDeductionAmount?: number;
      balanceAvailable?: boolean;
      balanceDaysAvailable?: number;
      balanceDaysToConsume?: number;
      remainingSalaryDays?: number;
      remainingSalaryDeductionAmount?: number;
      method?: string;
    };

    if (
      body.method !== "salary" &&
      body.method !== "balance" &&
      body.method !== "partial_balance" &&
      body.method !== "defer_to_balance" &&
      body.method !== "reject"
    ) {
      return NextResponse.json(
        { error: "invalid_request", message: "method must be 'salary', 'balance', 'partial_balance', 'defer_to_balance', or 'reject'." },
        { status: 400 },
      );
    }
    const requestId = String(body.requestId ?? "").trim();
    const employeeHrId = String(body.employeeHrId ?? "").trim();
    const startDate = String(body.startDate ?? "").trim();
    if (!requestId || !employeeHrId || !startDate) {
      return NextResponse.json(
        { error: "invalid_request", message: "requestId, employeeHrId, and startDate are required." },
        { status: 400 },
      );
    }

    await recordVacationSettlementDecision({
      runId,
      candidate: {
        requestId,
        employeeHrId,
        employeeName: null,
        vacationType: (body.vacationType as VacationType | undefined) ?? "annual",
        startDate,
        endDate: String(body.endDate ?? startDate),
        unpaidDays: Number(body.unpaidDays ?? 0),
        salaryDeductionAmount: Number(body.salaryDeductionAmount ?? 0),
        balanceAvailable: Boolean(body.balanceAvailable),
        balanceDaysAvailable: Number(body.balanceDaysAvailable ?? 0),
        balanceDaysToConsume: Number(body.balanceDaysToConsume ?? 0),
        remainingSalaryDays: Number(body.remainingSalaryDays ?? 0),
        remainingSalaryDeductionAmount: Number(body.remainingSalaryDeductionAmount ?? 0),
        existingSettlement: null,
      },
      method: body.method,
      decidedBy: resolveCopilotActor(access),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
