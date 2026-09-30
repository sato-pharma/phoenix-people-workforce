import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  BUSINESS_CARD_REQUEST_STATUSES,
  listAllBusinessCardRequests,
  updateBusinessCardRequestStatus,
  type BusinessCardRequestListFilter,
  type BusinessCardRequestStatus,
} from "@/lib/business-cards/request-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isStatusFilter(value: string): value is BusinessCardRequestStatus | "all" {
  return value === "all" || (BUSINESS_CARD_REQUEST_STATUSES as readonly string[]).includes(value);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status") ?? "all";
    const limitParam = Number(url.searchParams.get("limit") ?? "200");
    const filter: BusinessCardRequestListFilter = {
      limit: Number.isFinite(limitParam) ? limitParam : 200,
      status: isStatusFilter(statusParam) ? statusParam : "all",
    };
    const items = await listAllBusinessCardRequests(access, filter);
    return NextResponse.json({ items });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to business card requests." },
        { status: 403 },
      );
    }
    const message = clientSafeErrorMessage(error, "Business card requests failed to load.");
    return NextResponse.json({ error: "business_card_requests_load_failed", message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { id?: unknown; status?: unknown };
    const id = typeof body.id === "string" ? body.id : "";
    const status = typeof body.status === "string" ? body.status : "";
    if (!isStatusFilter(status) || status === "all") {
      return NextResponse.json(
        { error: "validation_failed", message: "A valid status is required." },
        { status: 400 },
      );
    }
    const item = await updateBusinessCardRequestStatus(access, id, status);
    return NextResponse.json({ item });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have permission to update business card requests." },
        { status: 403 },
      );
    }
    const message = clientSafeErrorMessage(error, "Business card request update failed.");
    return NextResponse.json({ error: "business_card_request_update_failed", message }, { status: 400 });
  }
}
