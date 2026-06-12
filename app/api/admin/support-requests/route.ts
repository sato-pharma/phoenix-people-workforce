import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  SUPPORT_REQUEST_STATUSES,
  listAllSupportRequests,
  updateSupportRequestStatus,
  type SupportRequestListFilter,
  type SupportRequestStatus,
} from "@/lib/support-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isStatusFilter(value: string): value is SupportRequestStatus | "all" {
  return value === "all" || (SUPPORT_REQUEST_STATUSES as readonly string[]).includes(value);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status") ?? "all";
    const limitParam = Number(url.searchParams.get("limit") ?? "100");
    const filter: SupportRequestListFilter = {
      limit: Number.isFinite(limitParam) ? limitParam : 100,
      status: isStatusFilter(statusParam) ? statusParam : "all",
    };
    const items = await listAllSupportRequests(access, filter);
    return NextResponse.json({ items });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to support requests." },
        { status: 403 },
      );
    }
    const message = error instanceof Error ? error.message : "Support requests failed to load.";
    return NextResponse.json({ error: "support_requests_load_failed", message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      id?: unknown;
      status?: unknown;
    };
    const id = typeof body.id === "string" ? body.id : "";
    const status = typeof body.status === "string" ? body.status : "";
    if (!isStatusFilter(status) || status === "all") {
      return NextResponse.json(
        { error: "validation_failed", message: "A valid status is required." },
        { status: 400 },
      );
    }
    const item = await updateSupportRequestStatus(access, id, status);
    return NextResponse.json({ item });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have permission to update support requests." },
        { status: 403 },
      );
    }
    const message = error instanceof Error ? error.message : "Support request update failed.";
    return NextResponse.json({ error: "support_request_update_failed", message }, { status: 400 });
  }
}
