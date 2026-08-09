import { NextResponse } from "next/server";

import {
  getModuleControlDashboard,
  parseModuleControlMutationRequest,
  parseModuleControlResetRequest,
  resetModuleControlAssignments,
  saveModuleControlAssignments,
} from "@/lib/admin/modules-control";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError, unauthorizedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertAuthenticated(access: { hrId: string | null; loginId?: string | null }) {
  if (!access.loginId && !access.hrId) {
    throw unauthorizedError();
  }
}

function modulesControlApiError(error: unknown) {
  const apiError = toApiError(error, "Modules Control request failed.");
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
    code: "modules_control_failed",
    message: clientSafeErrorMessage(error, "Modules Control request failed."),
    status: 500,
  };
}

function assertSuperAdmin(access: { role: string }) {
  if (access.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can use Modules Control.");
  }
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "module_control", "read");
    assertSuperAdmin(access);
    return NextResponse.json(await getModuleControlDashboard());
  } catch (error) {
    const { code, message, status } = modulesControlApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "module_control", "update");
    assertSuperAdmin(access);
    const payload = parseModuleControlMutationRequest(await request.json());
    return NextResponse.json(
      await saveModuleControlAssignments(payload, { loginId: access.loginId ?? null, role: access.role }),
      { status: 200 },
    );
  } catch (error) {
    const { code, message, status } = modulesControlApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "module_control", "update");
    assertSuperAdmin(access);
    const payload = parseModuleControlResetRequest(await request.json());
    return NextResponse.json(
      await resetModuleControlAssignments(payload, { loginId: access.loginId ?? null, role: access.role }),
      { status: 200 },
    );
  } catch (error) {
    const { code, message, status } = modulesControlApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
