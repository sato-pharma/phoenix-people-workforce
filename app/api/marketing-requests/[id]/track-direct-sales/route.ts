import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import {
  getMarketingRequestDirectTracking,
  setMarketingRequestTrackDirectSales,
} from "@/lib/marketing-requests/direct-tracking";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function directTrackingApiError(error: unknown) {
  const apiError = toApiError(error, "Direct-sales tracking request failed.");
  const status = isForbiddenError(error) ? 403 : apiError.status;
  const message = clientSafeErrorMessage(error, apiError.message);
  const notFound = errorMessageOf(error).toLowerCase().includes("marketing_request_not_found");
  return {
    code: status === 403 ? "forbidden" : notFound ? "not_found" : apiError.code,
    message: notFound ? "Marketing request was not found." : message,
    status: notFound ? 404 : status,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const state = await getMarketingRequestDirectTracking(access, id);
    return NextResponse.json(state);
  } catch (error) {
    const { code, message, status } = directTrackingApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({}));
    const enabled = Boolean((body as { enabled?: unknown }).enabled);

    const state = await setMarketingRequestTrackDirectSales(access, id, enabled);
    return NextResponse.json({ ...state, success: true });
  } catch (error) {
    const { code, message, status } = directTrackingApiError(error);
    return NextResponse.json({ error: code, message, success: false }, { status });
  }
}
