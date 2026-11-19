import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAccessContext } from "@/lib/auth/server";
import { parseJsonBody } from "@/lib/http/request-body";
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

/** A figure the route coerces with Number(): the tab sends numbers (null when the source figure was not a number). */
const NumberLike = z.union([z.number(), z.string()]).nullish();

/** The two decisions `recordExpenseDecision` takes. */
const EXPENSE_DECISIONS = ["include", "defer"] as const;

/**
 * The Expenses tab echoes the candidate row it loaded from GET (id, HR ID, dates, locations, km, type,
 * travel cost, allowance) with `decision`. Every field but the decision stays optional so a row missing
 * one still gets the route's own "requestId, employeeHrId, and dateFrom are required." answer.
 */
const ExpenseDecisionBodySchema = z.object({
  requestId: z.string().nullish(),
  employeeHrId: z.string().nullish(),
  dateFrom: z.string().nullish(),
  dateTo: z.string().nullish(),
  locationFrom: z.string().nullish(),
  locationTo: z.string().nullish(),
  km: NumberLike,
  type: z.string().nullish(),
  travelCost: NumberLike,
  allowance: NumberLike,
  decision: z.enum(EXPENSE_DECISIONS, { error: "decision must be 'include' or 'defer'." }),
});

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

    const parsed = await parseJsonBody(request, ExpenseDecisionBodySchema, { fallback: {} });
    if (!parsed.ok) {
      return NextResponse.json({ error: "invalid_request", message: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
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
