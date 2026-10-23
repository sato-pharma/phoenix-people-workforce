import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import {
  createMarketingValidationRecord,
  getMarketingValidationWorkspace,
} from "@/lib/marketing-requests/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function marketingValidationApiError(error: unknown) {
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
    normalized.includes("marketing_customer") ||
    normalized.includes("marketing_pharmac") ||
    normalized.includes("marketing_distributor") ||
    normalized.includes("marketing_request") ||
    normalized.includes("could not find the table") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return {
      code: "marketing_requests_schema_not_ready",
      message: "Marketing request validation schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing validation failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_validation_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketingValidationWorkspace(access));
  } catch (error) {
    const { code, message, status } = marketingValidationApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const rows = await createMarketingValidationRecord(await request.json(), access);

    return NextResponse.json({ row: rows[0] ?? null, rows }, { status: 201 });
  } catch (error) {
    const { code, message, status } = marketingValidationApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
