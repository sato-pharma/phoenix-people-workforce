import { NextResponse } from "next/server";

import { resolveAccessContext, isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  createMarketingRequestDraft,
  getMarketingRequestDraftWorkspace,
} from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function marketingDraftApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: error instanceof Error ? error.message : "Forbidden.",
      status: 403,
    };
  }

  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  const normalized = message.toLowerCase();
  // A real data/constraint error (e.g. a foreign-key violation on an approval step) is NOT a
  // missing schema — never mask it as "schema not applied", or the true cause stays hidden.
  const isConstraintViolation =
    normalized.includes("violates") ||
    normalized.includes("foreign key") ||
    normalized.includes("duplicate key") ||
    normalized.includes("constraint");
  const isSchemaMissing =
    !isConstraintViolation &&
    (normalized.includes("could not find the table") ||
      normalized.includes("schema cache") ||
      (normalized.includes("relation") && normalized.includes("does not exist")) ||
      (normalized.includes("does not exist") &&
        (normalized.includes("marketing_request") ||
          normalized.includes("marketing_customer") ||
          normalized.includes("marketing_product") ||
          normalized.includes("marketing_distributor"))));
  if (isSchemaMissing) {
    return {
      code: "marketing_requests_schema_not_ready",
      message: "Marketing request schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing request draft failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_request_draft_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketingRequestDraftWorkspace(access));
  } catch (error) {
    const { code, message, status } = marketingDraftApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const draft = await createMarketingRequestDraft(await request.json(), access);

    return NextResponse.json({ draft }, { status: 201 });
  } catch (error) {
    const { code, message, status } = marketingDraftApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
