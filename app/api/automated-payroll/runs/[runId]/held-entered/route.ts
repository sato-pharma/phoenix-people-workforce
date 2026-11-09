import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  deleteEnteredHeld,
  getEnteredHeldOverview,
  recordEnteredHeld,
} from "@/lib/automated-payroll/held-settlements";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Held in a month that did not record names (owner decision, 2026-11-09: HR types the held amount).
 *
 * July and August 2026 were published before the payroll kept each held person's amount, so the Held
 * Salary Release step had nobody to release from them. HR enters the person, the month and the amount
 * here, and the person then appears on the step with that amount outstanding.
 *
 * GET returns the months an amount can be entered against, what has been entered, and the employees
 * the picker offers (resigned included).
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    // Names people and salary figures — the same gate as the wizard itself.
    assertAutomatedPayrollHrActor(access);
    const overview = await getEnteredHeldOverview(access, runId);
    return NextResponse.json({ success: true, runId, ...overview });
  } catch (error) {
    return jsonError(error, "Failed to load the held amounts entered.");
  }
}

/** Record (or correct) the amount an earlier month withheld from one person. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      heldRunId?: string;
      hrId?: string;
      amount?: number | string;
      note?: string;
    };
    const access = await resolveAccessContext(request);
    const entry = await recordEnteredHeld(access, runId, {
      heldRunId: String(body.heldRunId ?? ""),
      hrId: String(body.hrId ?? ""),
      // Coerced here, not in the service: the service's own check must be able to reject a
      // genuinely non-numeric value rather than receive a silent NaN from an empty box.
      amount: typeof body.amount === "string" ? Number(body.amount) : Number(body.amount ?? Number.NaN),
      note: String(body.note ?? ""),
    });
    return NextResponse.json({ success: true, entry });
  } catch (error) {
    return jsonError(error, "Failed to record the held amount.");
  }
}

/** Withdraw an entered held amount typed in error. Refused once payroll has released any of it. */
export async function DELETE(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const url = new URL(request.url);
    const heldRunId = String(url.searchParams.get("heldRunId") ?? "").trim();
    const hrId = String(url.searchParams.get("hrId") ?? "").trim();
    const access = await resolveAccessContext(request);
    await deleteEnteredHeld(access, runId, heldRunId, hrId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error, "Failed to remove the held amount.");
  }
}
