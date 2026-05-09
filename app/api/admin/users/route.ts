import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { getRequestIp, getRequestUserAgent } from "@/lib/auth/audit";
import {
  assertRecentAuthentication,
  isForbiddenError,
  resolveAccessContext,
} from "@/lib/auth/server";
import {
  getAccessControlDashboard,
  updateAccessUserStatus,
  upsertAccessUser,
} from "@/lib/admin/access-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function adminApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      message: error instanceof Error ? error.message : "Forbidden.",
      status: 403,
    };
  }
  return {
    message: error instanceof Error ? error.message : "Access control request failed.",
    status: 500,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin_access", "read");
    return NextResponse.json(await getAccessControlDashboard());
  } catch (error) {
    const { message, status } = adminApiError(error);
    return NextResponse.json({ error: "access_users_load_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const payload = await request.json();
    const requestIp = getRequestIp(request);
    const userAgent = getRequestUserAgent(request);
    const targetRole = payload.role ? String(payload.role) : "";
    const hasPasswordReset = typeof payload.password === "string" && payload.password.trim().length > 0;
    await assertPermission(access, "user_admin", "create");
    await assertPermission(access, "user_admin", "update");

    if (typeof payload.isActive !== "undefined" && typeof payload.isActive !== "boolean") {
      return NextResponse.json(
        { error: "invalid_is_active", message: "isActive must be a boolean when provided." },
        { status: 400 },
      );
    }

    if (targetRole) {
      await assertPermission(access, "role_admin", "update");
      await assertRecentAuthentication(request);
    }

    if (hasPasswordReset) {
      await assertPermission(access, "password_admin", "update");
      await assertRecentAuthentication(request);
    }

    return NextResponse.json(
      await upsertAccessUser({
        email: payload.email ? String(payload.email) : null,
        hrId: payload.hrId ? String(payload.hrId) : null,
        isActive: typeof payload.isActive === "boolean" ? payload.isActive : undefined,
        line: payload.line ? String(payload.line) : null,
        loginId: String(payload.loginId ?? ""),
        managerHrId: payload.managerHrId ? String(payload.managerHrId) : null,
        name: payload.name ? String(payload.name) : null,
        password: payload.password ? String(payload.password) : null,
        role: payload.role,
        salesScopeOverride: payload.salesScopeOverride ?? null,
      }, {
        hrId: access.hrId ?? null,
        loginId: access.loginId ?? null,
        requestIp,
        role: access.role,
        userAgent,
      }),
      { status: 201 },
    );
  } catch (error) {
    const { message, status } = adminApiError(error);
    return NextResponse.json({ error: "access_user_save_failed", message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const requestIp = getRequestIp(request);
    const userAgent = getRequestUserAgent(request);
    await assertPermission(access, "user_admin", "update");
    const payload = await request.json();

    if (typeof payload.isActive !== "boolean") {
      return NextResponse.json(
        { error: "invalid_is_active", message: "isActive must be a boolean." },
        { status: 400 },
      );
    }

    await assertRecentAuthentication(request);

    return NextResponse.json(
      await updateAccessUserStatus(
        String(payload.loginId ?? ""),
        payload.isActive,
        {
          hrId: access.hrId ?? null,
          loginId: access.loginId ?? null,
          requestIp,
          role: access.role,
          userAgent,
        },
      ),
    );
  } catch (error) {
    const { message, status } = adminApiError(error);
    return NextResponse.json({ error: "access_user_status_failed", message }, { status });
  }
}
