import { NextResponse } from "next/server";

import {
  parseAccessUserRequest,
  parseAccessUserStatusRequest,
} from "@/lib/admin/access-validation";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getAccessControlDashboard,
  updateAccessUserStatus,
  upsertAccessUser,
} from "@/lib/admin/access-control";
import { toApiError, unauthorizedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function adminApiError(error: unknown) {
  const apiError = toApiError(error, "Access control request failed.");
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
      message: error instanceof Error ? error.message : "Forbidden.",
      status: 403,
    };
  }
  return {
    code: "access_control_failed",
    message: error instanceof Error ? error.message : "Access control request failed.",
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
    return NextResponse.json(await getAccessControlDashboard());
  } catch (error) {
    const { code, message, status } = adminApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "user_admin", "update");
    const payload = parseAccessUserRequest(await request.json());

    return NextResponse.json(
      await upsertAccessUser({
        email: payload.email,
        governanceReason: payload.governanceReason,
        hrId: payload.hrId,
        isActive: payload.isActive,
        line: payload.line,
        loginId: payload.loginId,
        managerHrId: payload.managerHrId,
        name: payload.name,
        role: payload.role,
        salesScopeOverride: payload.salesScopeOverride,
      }, { loginId: access.loginId ?? null, role: access.role }),
      { status: 201 },
    );
  } catch (error) {
    const { code, message, status } = adminApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "user_admin", "update");
    const payload = parseAccessUserStatusRequest(await request.json());

    return NextResponse.json(
      await updateAccessUserStatus(
        payload.loginId,
        payload.isActive,
        { loginId: access.loginId ?? null, role: access.role },
        payload.governanceReason,
      ),
    );
  } catch (error) {
    const { code, message, status } = adminApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
