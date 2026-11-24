import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { ProductionPlanningInputError } from "@/lib/production-planning/rules";
import {
  cancelExecution,
  executeProduction,
  previewExecution,
  recordFactoryBalance,
} from "@/lib/production-planning/service";
import { coerceProductionPlanningLanguage, productionPlanningStrings } from "@/lib/production-planning/strings";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The execution phase (owner, 2026-11-24): "I want to be in full control to either plan, either
 * execute." One door, four actions:
 *
 *   preview  — what a production would take off stock, written nowhere;
 *   execute  — record it, take the NET formula quantity off stock, wait for the factory's balance;
 *   balance  — the factory's own closing figures, which is when the waste is measured;
 *   cancel   — give a mistyped production's stock back, with a reason.
 *
 * Every write goes through the service, which asserts the planner's write level first and writes a
 * REQUIRED audit row (production_run).
 */
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    switch (body.action) {
      case "preview":
        return NextResponse.json(await previewExecution(access, body));
      case "execute":
        return NextResponse.json(await executeProduction(access, body), { status: 201 });
      case "balance":
        return NextResponse.json(await recordFactoryBalance(access, body));
      case "cancel":
        return NextResponse.json(await cancelExecution(access, body));
      default:
        throw new ProductionPlanningInputError(
          productionPlanningStrings(coerceProductionPlanningLanguage(body.lang)).errors.unknownExecutionAction,
          "action",
        );
    }
  } catch (error) {
    return productionPlanningErrorResponse(error, "Could not record the production.");
  }
}
