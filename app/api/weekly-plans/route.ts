import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  createEmployeePlan,
  getEmployeePlansWorkspace,
  isWeeklyPlanRpcError,
  type EmployeePlanItemInput,
} from "@/lib/weekly-planning/service";
import type { EmployeePlanKind } from "@/lib/weekly-planning/plan-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (isWeeklyPlanRpcError(error)) {
    return NextResponse.json(
      { error: `weekly_plan_${error.code}`, message: error.message, success: false },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")
        ? "forbidden"
        : "weekly_plan_error",
      message,
      success: false,
    },
    { status: isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:") ? 403 : 400 },
  );
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const workspace = await getEmployeePlansWorkspace(access);
    return NextResponse.json({ data: workspace, success: true });
  } catch (error) {
    return jsonError(error, "Unable to load plans workspace.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({})) as {
      anchorDate?: string;
      items?: EmployeePlanItemInput[];
      planKind?: EmployeePlanKind;
      submit?: boolean;
    };
    const planKind = body.planKind === "monthly" ? "monthly" : "weekly";
    const anchorDate = typeof body.anchorDate === "string" ? body.anchorDate : new Date().toISOString().slice(0, 10);
    const plan = await createEmployeePlan(access, {
      anchorDate,
      items: Array.isArray(body.items) ? body.items : [],
      planKind,
      submit: body.submit === true,
    });
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error, "Unable to create plan.");
  }
}
