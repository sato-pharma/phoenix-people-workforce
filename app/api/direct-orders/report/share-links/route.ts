import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createDirectOrderReportShareLink,
  listDirectOrderReportShareLinks,
  revokeDirectOrderReportShareLink,
} from "@/lib/direct-orders/report-share-links";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manage live report links: list what exists, create one, revoke one.
// The links themselves are served by /api/share/direct-orders/[token]/… which is deliberately
// unauthenticated; this route is the authenticated side that mints and kills them.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const links = await listDirectOrderReportShareLinks(access);
    return NextResponse.json({ links, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load share links.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (String(body.action ?? "") === "revoke") {
      await revokeDirectOrderReportShareLink(access, String(body.linkId ?? ""));
      return NextResponse.json({ success: true });
    }

    const result = await createDirectOrderReportShareLink(access, {
      surface: String(body.surface ?? "live") === "feed" ? "feed" : "live",
      label: body.label ? String(body.label) : null,
      passcode: body.passcode ? String(body.passcode) : null,
      expiresInDays: body.expiresInDays == null ? null : Number(body.expiresInDays),
      filters: body.filters ?? null,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not create the share link.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
