import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
import { listExpenseCandidates, priorPeriod, recordExpenseDecision } from "@/lib/payroll/copilot/expense-review";
import {
  buildExpenseReportWorkbook,
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
    const candidates = await listExpenseCandidates(period);

    if (new URL(request.url).searchParams.get("format") === "xlsx") {
      const buffer = await buildExpenseReportWorkbook({
        periodLabel: formatPeriodLabel(period),
        sourceMonthLabel: formatPeriodLabel(priorPeriod(period)),
        rows: candidates,
        hireDates: await getHireDateMap(),
      });
      return xlsxResponse(buffer, `Outstation_Expenses_${periodFileSlug(period)}.xlsx`);
    }

    return NextResponse.json({ candidates, sourceMonthLabel: formatPeriodLabel(priorPeriod(period)) });
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
      dateFrom?: string;
      dateTo?: string;
      locationFrom?: string;
      locationTo?: string;
      km?: number | null;
      type?: string;
      travelCost?: number;
      allowance?: number;
      decision?: string;
    };

    if (body.decision !== "include" && body.decision !== "defer") {
      return NextResponse.json(
        { error: "invalid_request", message: "decision must be 'include' or 'defer'." },
        { status: 400 },
      );
    }
    const requestId = String(body.requestId ?? "").trim();
    const employeeHrId = String(body.employeeHrId ?? "").trim();
    const dateFrom = String(body.dateFrom ?? "").trim();
    if (!requestId || !employeeHrId || !dateFrom) {
      return NextResponse.json(
        { error: "invalid_request", message: "requestId, employeeHrId, and dateFrom are required." },
        { status: 400 },
      );
    }

    await recordExpenseDecision({
      runId,
      candidate: {
        id: requestId,
        employeeHrId,
        employeeName: null,
        dateFrom,
        dateTo: String(body.dateTo ?? dateFrom),
        locationFrom: String(body.locationFrom ?? "—"),
        locationTo: String(body.locationTo ?? "—"),
        km: typeof body.km === "number" ? body.km : null,
        type: String(body.type ?? "traveling"),
        travelCost: Number(body.travelCost ?? 0),
        allowance: Number(body.allowance ?? 0),
        existingDecision: null,
      },
      decision: body.decision,
      decidedBy: resolveCopilotActor(access),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
