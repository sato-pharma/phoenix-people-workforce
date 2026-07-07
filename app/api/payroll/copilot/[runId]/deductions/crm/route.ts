import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
import { listCrmDeductionCandidates, syncCrmLiveMonthCandidates } from "@/lib/payroll/copilot/deductions-review";
import {
  buildDeductionReportWorkbook,
  formatPeriodLabel,
  getBaseSalaryMap,
  getHireDateMap,
  periodFileSlug,
  xlsxResponse,
} from "@/lib/payroll/copilot/report-exports";
import { getRunPeriod } from "@/lib/payroll/copilot/service";
import { resolveDayBasedDeductionAmount } from "@/lib/deductions-governance/calculations";
import { recordCopilotDeductionDecision } from "@/lib/deductions-governance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);
    const { runId } = await params;
    const period = await getRunPeriod(runId);
    await syncCrmLiveMonthCandidates(period, resolveCopilotActor(access));
    const { cycle, rows } = await listCrmDeductionCandidates(access, period);
    const hireDates = await getHireDateMap();
    // No-activity is a mandatory deduction (see buildApprovedDeductionTotals) — every
    // row without a decided amount already counts on the payroll sheet using this same
    // base-salary/30 x days estimate, so the tab must show it too rather than "—".
    const baseSalaries = await getBaseSalaryMap();

    if (new URL(request.url).searchParams.get("format") === "xlsx") {
      const buffer = await buildDeductionReportWorkbook({
        title: `CRM / No-Activity Deductions — ${formatPeriodLabel(period)}`,
        subtitle:
          "Field-workforce no-activity (N) days flagged for payroll deduction. Value = base salary / 30 x no-activity days (Approved once decided, otherwise an Estimate).",
        qtyHeader: "No-Activity Days",
        rows,
        hireDates,
        baseSalaries,
      });
      return xlsxResponse(buffer, `CRM_Deductions_${periodFileSlug(period)}.xlsx`);
    }

    return NextResponse.json({
      cycle,
      autoAppliesUnlessRejected: true,
      candidates: rows.map((row) => ({
        id: row.id,
        employeeHrId: row.employeeCode,
        employeeName: row.employeeName,
        hireDate: hireDates.get(row.employeeHrIdCompact) ?? null,
        deductionType: row.deductionType,
        deductionUnit: row.deductionUnit,
        deductionValue: row.deductionValue,
        estimatedAmount:
          row.estimatedAmount ??
          resolveDayBasedDeductionAmount({
            decision: row.decision,
            deductionValue: row.deductionValue,
            baseSalary: baseSalaries.get(row.employeeHrIdCompact),
          }),
        severity: row.severity,
        dates: row.dates,
        decisionStatus: row.decision?.decisionStatus ?? "Pending",
        appliedDeductionValue: row.decision?.appliedDeductionValue ?? null,
        appliedAmount: row.decision?.appliedAmount ?? null,
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
    await params; // runId not needed by the write itself — decisions are keyed by candidateId.

    const body = (await request.json().catch(() => ({}))) as {
      candidateId?: string;
      decisionStatus?: string;
      appliedDeductionValue?: number;
    };
    const candidateId = String(body.candidateId ?? "").trim();
    if (!candidateId) {
      return NextResponse.json({ error: "invalid_request", message: "candidateId is required." }, { status: 400 });
    }
    if (body.decisionStatus !== "Approved for Payroll" && body.decisionStatus !== "Do Not Take Action") {
      return NextResponse.json(
        { error: "invalid_request", message: "decisionStatus must be 'Approved for Payroll' or 'Do Not Take Action'." },
        { status: 400 },
      );
    }

    const decision = await recordCopilotDeductionDecision({
      candidateId,
      decisionStatus: body.decisionStatus,
      appliedDeductionValue:
        typeof body.appliedDeductionValue === "number" ? body.appliedDeductionValue : null,
      actorLoginId: resolveCopilotActor(access),
    });

    return NextResponse.json({ decision });
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
