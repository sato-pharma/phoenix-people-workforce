import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isDevelopment } from "@/lib/env";
import { ApiError } from "@/lib/http/api-errors";
import {
  createRetentionConversation,
  getRetentionDashboardData,
  isRetentionSchemaMissing,
  retentionErrorMessage,
  updateRetentionConversation,
} from "@/lib/retention/service";
import type {
  CreateRetentionConversationInput,
  UpdateRetentionConversationInput,
} from "@/lib/retention/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function retentionApiError(error: unknown) {
  if (isForbiddenError(error)) return { message: retentionErrorMessage(error), status: 403 };
  // A save that lost its compare-and-set (someone else saved the conversation since this screen
  // loaded it) is 409, and a malformed loaded version is 400 — the service throws both as ApiError.
  if (error instanceof ApiError && (error.status === 409 || error.status === 400)) {
    return { message: error.message, status: error.status };
  }
  if (isRetentionSchemaMissing(error)) {
    return {
      message: isDevelopment ? retentionErrorMessage(error) : "Retention schema is not ready.",
      status: 409,
    };
  }
  return { message: retentionErrorMessage(error), status: 500 };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "retention", "read");
    return NextResponse.json(await getRetentionDashboardData(access));
  } catch (error) {
    const { message, status } = retentionApiError(error);
    return NextResponse.json({ error: "retention_load_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "retention", "create");

    const payload = (await request.json()) as { conversation?: CreateRetentionConversationInput };
    if (!payload.conversation) {
      return NextResponse.json(
        { error: "missing_conversation", message: "A conversation payload is required." },
        { status: 400 },
      );
    }

    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    await createRetentionConversation(payload.conversation, actor);
    return NextResponse.json(await getRetentionDashboardData(access));
  } catch (error) {
    const { message, status } = retentionApiError(error);
    return NextResponse.json({ error: "retention_create_failed", message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "retention", "update");

    const payload = (await request.json()) as { conversation?: UpdateRetentionConversationInput };
    if (!payload.conversation?.id) {
      return NextResponse.json(
        { error: "missing_conversation", message: "A conversation id is required." },
        { status: 400 },
      );
    }

    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    await updateRetentionConversation(payload.conversation, actor);
    return NextResponse.json(await getRetentionDashboardData(access));
  } catch (error) {
    const { message, status } = retentionApiError(error);
    return NextResponse.json({ error: "retention_update_failed", message }, { status });
  }
}
