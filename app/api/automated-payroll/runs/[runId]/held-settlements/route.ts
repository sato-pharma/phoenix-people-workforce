import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  deleteHeldSettlement,
  loadHeldBalances,
  recordHeldSettlement,
} from "@/lib/automated-payroll/held-settlements";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "This held salary was already transferred outside payroll" (owner rule 2026-09-10).
 *
 * A held row is dropped at publish, so the person is paid by hand during the month and nothing
 * recorded it. Without a record the same amount can be worked up again next month, and a month
 * later nobody can answer whether it was ever settled.
 *
 * GET returns every held balance across published runs — what was withheld, what has been recorded
 * as transferred, and what is still outstanding. It deliberately answers for ALL months rather than
 * just this run, because the question that matters when working a new month is "what do we still
 * owe from before".
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    // Held balances name people and salary figures, so this is the same gate as the wizard itself
    // rather than the wider finance read role.
    assertAutomatedPayrollHrActor(access);
    const balances = await loadHeldBalances();
    return NextResponse.json({
      success: true,
      runId,
      balances,
      outstandingTotal:
        Math.round(balances.reduce((sum, balance) => sum + balance.outstanding, 0) * 100) / 100,
    });
  } catch (error) {
    return jsonError(error, "Failed to load held settlements.");
  }
}

/** Record (or correct) a transfer made outside payroll against one held person. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      hrId?: string;
      amount?: number | string;
      paidOn?: string;
      method?: string;
      reference?: string;
      note?: string;
    };
    const access = await resolveAccessContext(request);
    const settlement = await recordHeldSettlement(access, runId, {
      hrId: String(body.hrId ?? ""),
      // Coerced here, not in the service: the service's own check must be able to reject a
      // genuinely non-numeric value rather than receive a silent NaN from an empty box.
      amount: typeof body.amount === "string" ? Number(body.amount) : Number(body.amount ?? Number.NaN),
      paidOn: String(body.paidOn ?? "").slice(0, 10),
      method: body.method ?? null,
      reference: body.reference ?? null,
      note: body.note ?? null,
    });
    return NextResponse.json({ success: true, settlement });
  } catch (error) {
    return jsonError(error, "Failed to record the transfer.");
  }
}

/** Withdraw a settlement recorded in error. Re-opens the balance, and is audited. */
export async function DELETE(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const url = new URL(request.url);
    const hrId = String(url.searchParams.get("hrId") ?? "").trim();
    const access = await resolveAccessContext(request);
    await deleteHeldSettlement(access, runId, hrId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error, "Failed to withdraw the settlement.");
  }
}
