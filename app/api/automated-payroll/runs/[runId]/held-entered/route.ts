import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  deleteEnteredHeld,
  getEnteredHeldOverview,
  recordEnteredHeld,
} from "@/lib/automated-payroll/held-settlements";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ heldRunId, hrId, amount, note }` from the held-entered panel and the Held Salary Release step
 * (REC-060). The amount may arrive as a number or a typed string; the service judges its value.
 */
const EnteredHeldBodySchema = z.object({
  heldRunId: z.string().optional(),
  hrId: z.string().optional(),
  amount: z.union([z.number(), z.string()]).nullable().optional(),
  note: z.string().optional(),
});

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
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, EnteredHeldBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
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
