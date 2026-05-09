import { NextResponse } from "next/server";

import {
  assertPermission,
  getPermissionMatrix,
} from "@/lib/auth/permissions";
import { getRequestIp, getRequestUserAgent } from "@/lib/auth/audit";
import {
  assertRecentAuthentication,
  isForbiddenError,
  resolveAccessContext,
} from "@/lib/auth/server";
import { upsertRolePermissionOverride } from "@/lib/admin/access-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function permissionsApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      message: error instanceof Error ? error.message : "Forbidden.",
      status: 403,
    };
  }

  return {
    message: error instanceof Error ? error.message : "Permissions request failed.",
    status: 500,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "permission_admin", "read");
    return NextResponse.json(await getPermissionMatrix());
  } catch (error) {
    const { message, status } = permissionsApiError(error);
    return NextResponse.json({ error: "permissions_load_failed", message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "permission_admin", "update");
    await assertRecentAuthentication(request);
    if (access.role !== "Super Admin") {
      return NextResponse.json({ error: "forbidden", message: "Only Super Admin can update permissions." }, { status: 403 });
    }

    const payload = await request.json();
    const requestIp = getRequestIp(request);
    const userAgent = getRequestUserAgent(request);
    const role = String(payload.role ?? "");
    const resource = String(payload.resource ?? "");
    const action = String(payload.action ?? "").trim().toLowerCase();

    if (typeof payload.isAllowed !== "boolean") {
      return NextResponse.json({ error: "invalid_is_allowed", message: "isAllowed must be a boolean." }, { status: 400 });
    }

    return NextResponse.json(
      await upsertRolePermissionOverride({
        action,
        isAllowed: payload.isAllowed,
        resource,
        role,
      }, {
        hrId: access.hrId ?? null,
        loginId: access.loginId ?? null,
        requestIp,
        role: access.role,
        userAgent,
      }),
      { status: 200 },
    );
  } catch (error) {
    const { message, status } = permissionsApiError(error);
    return NextResponse.json({ error: "permission_update_failed", message }, { status });
  }
}
