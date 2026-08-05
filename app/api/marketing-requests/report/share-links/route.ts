import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  createMarketingReportShareLink,
  listMarketingReportShareLinks,
  revokeMarketingReportShareLink,
} from "@/lib/marketing-requests/report-share-links";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manage the live Marketing Request sheet links: list what exists, mint one, revoke one.
// The links themselves are served by /api/share/marketing-requests/[token]/… which is deliberately
// unauthenticated; this route is the authenticated side that mints and kills them.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const links = await listMarketingReportShareLinks(access);
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
      await revokeMarketingReportShareLink(access, String(body.linkId ?? ""));
      return NextResponse.json({ success: true });
    }

    const result = await createMarketingReportShareLink(access, {
      allowFiles: Boolean(body.allowFiles),
      expiresInDays: body.expiresInDays == null ? null : Number(body.expiresInDays),
      label: body.label ? String(body.label) : null,
      passcode: body.passcode ? String(body.passcode) : null,
      surface: String(body.surface ?? "live") === "feed" ? "feed" : "live",
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
