import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  createEmployeePlan,
  getEmployeePlansWorkspace,
  isWeeklyPlanRpcError,
  type EmployeePlanItemInput,
} from "@/lib/weekly-planning/service";
import type { EmployeePlanKind } from "@/lib/weekly-planning/plan-v1";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string) {
  const message = clientSafeErrorMessage(error, fallback);
  if (isWeeklyPlanRpcError(error)) {
    return NextResponse.json(
      { error: `weekly_plan_${error.code}`, message: error.message, success: false },
      { status: error.status },
    );
  }
  // A signed-out caller (assertSignedIn, REC-080) keeps its 401 rather than the 400 below.
  if (error instanceof ApiError && error.status === 401) {
    return NextResponse.json({ error: error.code, message: error.message, success: false }, { status: 401 });
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
    // REC-080: the legacy form answers 409 (plans moved) to everyone, so the caller is judged first: a
    // signed-out caller gets 401 and a role without weekly_plans:create gets 403; anyone holding it still
    // reaches the 409.
    assertSignedIn(access);
    await assertPermission(access, "weekly_plans", "create");
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
