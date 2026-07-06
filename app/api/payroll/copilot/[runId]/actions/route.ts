import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
import { applyActionsToRun } from "@/lib/payroll/copilot/service";
import { COPILOT_OVERRIDE_FIELDS, type ProposedAction } from "@/lib/payroll/copilot/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Structurally validate the posted (already-confirmed) actions before applying. */
function coerceActions(input: unknown): ProposedAction[] {
  if (!Array.isArray(input)) return [];
  const out: ProposedAction[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const kind = String(a.kind ?? "");
    const hrId = String(a.hrId ?? "").trim();
    if (!hrId) continue;
    const reason = typeof a.reason === "string" && a.reason ? a.reason : `${kind} via chat`;

    switch (kind) {
      case "bonus":
      case "penalty":
      case "advance": {
        const amount = num(a.amount);
        if (amount === null || amount <= 0) continue;
        out.push({ kind, hrId, amount, reason });
        break;
      }
      case "loan": {
        const monthlyAmount = num(a.monthlyAmount);
        const installments = num(a.installments);
        if (monthlyAmount === null || monthlyAmount <= 0 || installments === null || installments < 1) continue;
        out.push({ kind, hrId, monthlyAmount, installments: Math.round(installments), reason });
        break;
      }
      case "prorate": {
        const workedDays = num(a.workedDays);
        if (workedDays === null || workedDays < 0) continue;
        out.push({ kind, hrId, workedDays: Math.round(workedDays), reason });
        break;
      }
      case "override": {
        const field = String(a.field ?? "");
        const value = num(a.value);
        if (!COPILOT_OVERRIDE_FIELDS.includes(field as (typeof COPILOT_OVERRIDE_FIELDS)[number]) || value === null) {
          continue;
        }
        out.push({ kind, hrId, field: field as (typeof COPILOT_OVERRIDE_FIELDS)[number], value, reason });
        break;
      }
      case "include":
      case "defer":
      case "confirm":
        out.push({ kind, hrId, reason });
        break;
      case "hold": {
        // Comment is mandatory (shown on the employee's payslip) — never fall
        // back to a generic placeholder like the other kinds do.
        const comment = typeof a.reason === "string" ? a.reason.trim() : "";
        if (!comment) continue;
        out.push({ kind, hrId, reason: comment });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);
    const { runId } = await params;

    const body = (await request.json().catch(() => ({}))) as { actions?: unknown };
    const actions = coerceActions(body.actions);

    const view = await applyActionsToRun(runId, actions, resolveCopilotActor(access));
    return NextResponse.json({ ...view, appliedActions: actions.length });
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
