import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { resolveAccessContext, isForbiddenError } from "@/lib/auth/server";
import { logAppError } from "@/lib/error-monitor/service";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import {
  createMarketingRequestDraft,
  getMarketingRequestDraftWorkspace,
} from "@/lib/marketing-requests/service";
import { getDeployRevisionTag } from "@/lib/observability/deploy-identity";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DraftAccess = Awaited<ReturnType<typeof resolveAccessContext>> | null;

/**
 * Record a failed draft load/save in app_error_events.
 *
 * Every failure on this route used to be caught and returned as a JSON body and nothing else —
 * no row, no log line. So a requester blocked by a real gate (`customer_not_validated`,
 * `product_line_not_allowed`, `requester_line_not_assigned`, a 503 schema gap) hit a dead end
 * that was invisible from the admin side: the only way to tell "she failed" from "she never
 * finished the form" was to diff the tables by hand. This route carries a handful of requests a
 * day, so logging every non-2xx is signal, not noise.
 *
 * Best-effort by construction: logAppError never throws, and this is wrapped anyway — a logging
 * failure must never replace the real error the caller is already returning.
 */
async function logMarketingDraftFailure(params: {
  access: DraftAccess;
  code: string;
  error: unknown;
  message: string;
  request: Request;
  routeType: "load" | "create";
}) {
  try {
    await logAppError({
      environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
      hrId: params.access?.hrId ?? null,
      loginId: params.access?.loginId ?? null,
      // The code is the diagnosis — keep it in the message so the error monitor shows which
      // gate fired without needing the stack.
      message: `[${params.code}] ${params.message}`,
      moduleKey: "marketing_requests",
      moduleLabel: "Marketing Requests",
      release: getDeployRevisionTag(),
      role: params.access?.role ?? null,
      route: new URL(params.request.url).pathname,
      routeType: params.routeType,
      source: "server",
      stack: params.error instanceof Error ? params.error.stack ?? null : null,
      userAgent: params.request.headers.get("user-agent"),
    });
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}

function marketingDraftApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: clientSafeErrorMessage(error, "Forbidden."),
      status: 403,
    };
  }

  const message = errorMessageOf(error);
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
  // Hoisted so the catch can attribute the failure to a person — without it every logged row
  // would be anonymous, which is most of the value.
  let access: DraftAccess = null;
  try {
    access = await resolveAccessContext(request);
    // An expired session is not a permissions problem. Without this the guest fallback
    // (hrId null, role "Employee") reaches assertPermission, throws
    // "Forbidden: Employee cannot use marketing requests", and lands in app_error_events as an
    // application error naming a role nobody actually holds.
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    return NextResponse.json(await getMarketingRequestDraftWorkspace(access));
  } catch (error) {
    const { code, message, status } = marketingDraftApiError(error);
    await logMarketingDraftFailure({ access, code, error, message, request, routeType: "load" });
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function POST(request: Request) {
  let access: DraftAccess = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) {
      // Returns early, so it never reaches the catch below — log it here or a rejected save
      // looks identical to a button that did nothing.
      await logMarketingDraftFailure({
        access,
        code: "csrf_rejected",
        error: null,
        message: "Same-origin check rejected the draft submission.",
        request,
        routeType: "create",
      });
      return csrfError;
    }

    access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    const draft = await createMarketingRequestDraft(await request.json(), access);

    return NextResponse.json({ draft }, { status: 201 });
  } catch (error) {
    const { code, message, status } = marketingDraftApiError(error);
    await logMarketingDraftFailure({ access, code, error, message, request, routeType: "create" });
    return NextResponse.json({ error: code, message }, { status });
  }
}
