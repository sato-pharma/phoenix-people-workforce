import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import {
  getMarketingControlWorkspace,
  updateMarketingControlRequestType,
  updateMarketingControlSetting,
  updateMarketingControlWorkflowStep,
} from "@/lib/marketing-requests/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function marketingControlApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: clientSafeErrorMessage(error, "Forbidden."),
      status: 403,
    };
  }

  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("marketing_control_settings") ||
    normalized.includes("marketing_request_types") ||
    normalized.includes("marketing_workflow_steps") ||
    normalized.includes("could not find the table") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return {
      code: "marketing_control_schema_not_ready",
      message: "Marketing control schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing control failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_control_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketingControlWorkspace(access));
  } catch (error) {
    const { code, message, status } = marketingControlApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = await request.json();
    const entity = String(body?.entity ?? "");

    if (entity === "setting") {
      return NextResponse.json({
        setting: await updateMarketingControlSetting({
          settingKey: body?.settingKey,
          value: body?.value,
        }, access),
      });
    }

    if (entity === "request_type") {
      return NextResponse.json({
        requestType: await updateMarketingControlRequestType({
          id: body?.id,
          patch: body?.patch ?? {},
        }, access),
      });
    }

    if (entity === "workflow_step") {
      return NextResponse.json({
        workflowStep: await updateMarketingControlWorkflowStep({
          id: body?.id,
          patch: body?.patch ?? {},
        }, access),
      });
    }

    return NextResponse.json({
      error: "invalid_control_entity",
      message: "Control entity is invalid.",
    }, { status: 400 });
  } catch (error) {
    const { code, message, status } = marketingControlApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
