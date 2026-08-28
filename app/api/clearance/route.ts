import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  clearanceErrorMessage,
  decideClearanceItem,
  getClearanceDashboardData,
  isClearanceSchemaMissing,
  openClearanceChecklist,
  releaseClearanceSettlement,
} from "@/lib/clearance/service";
import type { DecideClearanceItemInput } from "@/lib/clearance/types";
import { isDevelopment } from "@/lib/env";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clearanceApiError(error: unknown) {
  if (isForbiddenError(error)) return { message: clearanceErrorMessage(error), status: 403 };
  if (isClearanceSchemaMissing(error)) {
    return {
      message: isDevelopment ? clearanceErrorMessage(error) : "Clearance schema is not ready.",
      status: 409,
    };
  }
  return { message: clearanceErrorMessage(error), status: 500 };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "clearance", "read");
    return NextResponse.json(await getClearanceDashboardData(access));
  } catch (error) {
    const { message, status } = clearanceApiError(error);
    return NextResponse.json({ error: "clearance_load_failed", message }, { status });
  }
}

/**
 * Three mutations, one route, separated by `action`.
 *
 * `release` is gated on `update` like the others rather than on `approve`. That is deliberate:
 * `approve` on this resource would read as approving the settlement itself, which is a payroll
 * decision HR Operations explicitly may not make. Recording that a settlement was released is a
 * statement of fact about a handover, and the database refuses it while any station is undecided.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const payload = (await request.json()) as {
      action?: "open" | "decide" | "release";
      resignationId?: string;
      item?: DecideClearanceItemInput;
      checklistId?: string;
      note?: string | null;
    };

    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    if (payload.action === "open") {
      await assertPermission(access, "clearance", "create");
      if (!payload.resignationId) {
        return NextResponse.json(
          { error: "missing_resignation", message: "A resignation is required to open a clearance." },
          { status: 400 },
        );
      }
      await openClearanceChecklist(payload.resignationId, actor);
      return NextResponse.json(await getClearanceDashboardData(access));
    }

    if (payload.action === "decide") {
      await assertPermission(access, "clearance", "update");
      if (!payload.item?.itemId || !payload.item.status) {
        return NextResponse.json(
          { error: "missing_item", message: "A station and a decision are required." },
          { status: 400 },
        );
      }
      await decideClearanceItem(payload.item, actor);
      return NextResponse.json(await getClearanceDashboardData(access));
    }

    if (payload.action === "release") {
      await assertPermission(access, "clearance", "update");
      if (!payload.checklistId) {
        return NextResponse.json(
          { error: "missing_checklist", message: "A clearance is required to record a release." },
          { status: 400 },
        );
      }
      await releaseClearanceSettlement({ checklistId: payload.checklistId, note: payload.note }, actor);
      return NextResponse.json(await getClearanceDashboardData(access));
    }

    return NextResponse.json(
      { error: "unknown_action", message: "Unknown clearance action." },
      { status: 400 },
    );
  } catch (error) {
    const { message, status } = clearanceApiError(error);
    return NextResponse.json({ error: "clearance_action_failed", message }, { status });
  }
}
