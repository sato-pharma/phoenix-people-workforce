import { NextResponse, type NextRequest } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isAuditId } from "@/lib/system-audit/page-query";
import { recordScreenshotView } from "@/lib/system-audit/screenshot-views";
import { loadUserScreenImage } from "@/lib/system-audit/user-screens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/system-audit/screens/[id] — one screenshot of what a person saw, AS-IS, for the
 * System Audit row drawer (owner, 23 Oct 2026: shown to the Super Admin only, never blurred, kept 90
 * days). Super Admin only: the guard runs before anything is read. The picture is streamed from the
 * private bucket by this route — no signed URL ever leaves the server — and is never cached by the
 * browser or anything between. Unknown or pruned id → 404. Every picture served writes one
 * `system_audit_screenshot_view` audit row first — who looked, at whose screen (owner, 23 Oct 2026:
 * "log every screenshot view").
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;
    assertSystemAdministratorWorkspaceAccess(access, "the System Error & Data Integrity Audit");

    const { id } = await context.params;
    if (!isAuditId(id)) {
      return NextResponse.json({ error: "invalid_request", message: "That screenshot id is not valid." }, { status: 400 });
    }
    const image = await loadUserScreenImage(id);
    if (!image) {
      return NextResponse.json(
        { error: "not_found", message: "No screenshot has that id — it may have passed its 90 days." },
        { status: 404 },
      );
    }
    await recordScreenshotView(
      { hrId: access.hrId ?? null, loginId: access.loginId ?? null },
      {
        source: "screen",
        id,
        screenKind: image.taken.kind,
        hrId: image.taken.hrId,
        loginId: image.taken.loginId,
        page: image.taken.pagePath,
        takenAt: image.taken.capturedAt,
        isTest: image.taken.isTest,
      },
    );
    return new NextResponse(image.bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": image.contentType,
        "x-content-type-options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    const reason = clientSafeErrorMessage(error, "the screenshot store did not answer");
    return NextResponse.json({ error: "unavailable", message: `Unavailable — ${reason}` }, { status: 500 });
  }
}
