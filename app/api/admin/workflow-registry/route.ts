import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, unauthorizedError } from "@/lib/http/api-errors";
import {
  createWorkflowRegistryModule,
  getWorkflowRegistryDashboard,
} from "@/lib/workflow-registry/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertAuthenticated(access: { hrId: string | null; loginId?: string | null }) {
  if (!access.loginId && !access.hrId) {
    throw unauthorizedError();
  }
}

function workflowRegistryApiError(error: unknown) {
  const apiError = toApiError(error, "Workflow registry request failed.");
  if (apiError.status !== 500 || apiError.code === "audit_persistence_failed") {
    return apiError;
  }
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: error instanceof Error ? error.message : "Forbidden.",
      status: 403,
    };
  }
  return {
    code: "workflow_registry_failed",
    message: error instanceof Error ? error.message : "Workflow registry request failed.",
    status: 500,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "workflow_registry", "read");

    return NextResponse.json(await getWorkflowRegistryDashboard());
  } catch (error) {
    const { code, message, status } = workflowRegistryApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "workflow_registry", "create");

    return NextResponse.json(
      await createWorkflowRegistryModule(await request.json(), {
        loginId: access.loginId ?? null,
        role: access.role,
      }),
      { status: 201 },
    );
  } catch (error) {
    const { code, message, status } = workflowRegistryApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
