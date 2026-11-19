import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAccessContext } from "@/lib/auth/server";
import { parseJsonBody } from "@/lib/http/request-body";
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
import { SETTLEMENT_PAYMENT_METHODS } from "@/lib/payroll/copilot/settlement-slot";
import {
  listUnpaidVacationCandidates,
  recordVacationSettlementDecision,
} from "@/lib/payroll/copilot/vacation-settlement";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { VACATION_TYPES } from "@/lib/vacation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A figure the route coerces with Number(): the tab sends numbers (null when the source figure was not a number). */
const NumberLike = z.union([z.number(), z.string()]).nullish();

/** The methods `recordVacationSettlementDecision` takes: the four payment methods and reject. */
const VACATION_SETTLEMENT_DECISIONS = [...SETTLEMENT_PAYMENT_METHODS, "reject"] as const;

/**
 * The leave types a candidate can carry. The tab echoes the type the leave request stored, and
 * `v2_vacation_requests.vacation_type` is held to exactly these five by its check constraint; the
 * balance-settlement email quotes it, so it is passed on as sent, never re-mapped.
 */
const VACATION_TYPE_VALUES = VACATION_TYPES.map((option) => option.value);

/**
 * The Unpaid Vacation tab echoes the candidate row it loaded from GET with `method`. Every field but
 * the method stays optional so a row missing one still gets the route's own "requestId, employeeHrId,
 * and startDate are required." answer.
 */
const VacationSettlementBodySchema = z.object({
  requestId: z.string().nullish(),
  employeeHrId: z.string().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  unpaidDays: NumberLike,
  vacationType: z.enum(VACATION_TYPE_VALUES).nullish(),
  salaryDeductionAmount: NumberLike,
  balanceAvailable: z.boolean().nullish(),
  balanceDaysAvailable: NumberLike,
  balanceDaysToConsume: NumberLike,
  remainingSalaryDays: NumberLike,
  remainingSalaryDeductionAmount: NumberLike,
  method: z.enum(VACATION_SETTLEMENT_DECISIONS, {
    error: "method must be 'salary', 'balance', 'partial_balance', 'defer_to_balance', or 'reject'.",
  }),
});

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

    const parsed = await parseJsonBody(request, VacationSettlementBodySchema, { fallback: {} });
    if (!parsed.ok) {
      return NextResponse.json({ error: "invalid_request", message: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
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
        vacationType: body.vacationType ?? "annual",
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
