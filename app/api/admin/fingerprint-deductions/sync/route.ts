import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { actorId, assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { syncAttendanceDeviceDeductionCandidates } from "@/lib/deductions-governance/connectors/attendance-device";
import { monthKeysForWindow, resolveCopilotCycleWindow } from "@/lib/payroll/copilot/deductions-review";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pulls fresh fingerprint deduction candidates from the latest device punches into
 * deduction_candidates for this cycle's month_key(s), insert-only/idempotent (skips
 * rows that already exist). Without this the page only ever shows whatever some
 * OTHER surface (Deductions Governance, Payroll Copilot) already synced.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertAutomatedPayrollHrActor(access);

    const body = (await request.json().catch(() => ({}))) as { month?: number; year?: number };
    const month = Number(body.month);
    const year = Number(body.year);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000) {
      return NextResponse.json(
        { error: "invalid_request", message: "month (1-12) and year are required." },
        { status: 400 },
      );
    }

    const cycle = await resolveCopilotCycleWindow({ month, year });
    const monthKeys = monthKeysForWindow(cycle);
    const createdBy = actorId(access);
    const results = await Promise.all(
      monthKeys.map((monthKey) => syncAttendanceDeviceDeductionCandidates({ createdBy, monthKey })),
    );

    const summary = results.reduce(
      (total, result) => ({
        sourceTotal: total.sourceTotal + result.sourceTotal,
        created: total.created + result.created,
        skippedExisting: total.skippedExisting + result.skippedExisting,
        warnings: [...total.warnings, ...result.warnings],
      }),
      { sourceTotal: 0, created: 0, skippedExisting: 0, warnings: [] as string[] },
    );

    return NextResponse.json({ cycle, monthKeys, ...summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    const forbidden = message.startsWith("Forbidden:");
    return NextResponse.json(
      { error: forbidden ? "forbidden" : "invalid_request", message },
      { status: forbidden ? 403 : 400 },
    );
  }
}
