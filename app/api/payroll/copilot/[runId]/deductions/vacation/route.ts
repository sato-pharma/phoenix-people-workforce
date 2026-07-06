import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
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
      method?: string;
    };

    if (body.method !== "salary" && body.method !== "balance" && body.method !== "reject") {
      return NextResponse.json(
        { error: "invalid_request", message: "method must be 'salary', 'balance', or 'reject'." },
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
    if (body.method === "balance" && !body.balanceAvailable) {
      return NextResponse.json(
        { error: "invalid_request", message: "Insufficient vacation balance to settle this against balance." },
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
        balanceDaysAvailable: 0,
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
