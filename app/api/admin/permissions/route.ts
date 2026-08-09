import { NextResponse } from "next/server";

import { parsePermissionOverrideRequest } from "@/lib/admin/access-validation";
import {
  assertPermission,
  getPermissionMatrix,
} from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { upsertRolePermissionOverride } from "@/lib/admin/access-control";
import { clientSafeErrorMessage, toApiError, unauthorizedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function permissionsApiError(error: unknown) {
  const apiError = toApiError(error, "Permissions request failed.");
  if (apiError.status !== 500 || apiError.code === "audit_persistence_failed") {
    return {
      code: apiError.code,
      message: apiError.message,
      status: apiError.status,
    };
  }
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: clientSafeErrorMessage(error, "Forbidden."),
      status: 403,
    };
  }

  return {
    code: "permissions_failed",
    message: clientSafeErrorMessage(error, "Permissions request failed."),
    status: 500,
  };
}

function assertAuthenticated(access: { hrId: string | null; loginId?: string | null }) {
  if (!access.loginId && !access.hrId) {
    throw unauthorizedError();
  }
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "admin_access", "read");
    return NextResponse.json(await getPermissionMatrix());
  } catch (error) {
    const { code, message, status } = permissionsApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "permission_admin", "update");
    if (access.role !== "Super Admin") {
      return NextResponse.json({ error: "forbidden", message: "Only Super Admin can update permissions." }, { status: 403 });
    }

    const payload = parsePermissionOverrideRequest(await request.json());

    return NextResponse.json(
      await upsertRolePermissionOverride({
        action: payload.action,
        governanceReason: payload.governanceReason,
        isAllowed: payload.isAllowed,
        resource: payload.resource,
        role: payload.role,
      }, { loginId: access.loginId ?? null, role: access.role }),
      { status: 200 },
    );
  } catch (error) {
    const { code, message, status } = permissionsApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
