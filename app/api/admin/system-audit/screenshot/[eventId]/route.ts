import { NextResponse, type NextRequest } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ERROR_SCREENSHOT_BUCKET } from "@/lib/error-monitor/screenshot-intake";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long enough to open the drawer and look; short enough that a copied link is dead by the time it travels. */
const SIGNED_URL_TTL_SECONDS = 300;

/**
 * GET /api/admin/system-audit/screenshot/[eventId] — a short-lived signed URL for the picture taken
 * when that `app_error_events` row was reported. Super Admin only.
 *
 * WHY A ROUTE AND NOT A URL IN THE PAYLOAD. The bucket is private and the images are unmasked by the
 * owner's decision of 23 Oct 2026 — a payslip that errors is photographed with the pay on it. So the
 * capability is minted per view, against the viewer's own session, and expires; nothing durable is
 * ever rendered into the page. The path is read from the row rather than taken from the caller, so a
 * signed URL can only ever be issued for an object this table really points at.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ eventId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;
    assertSystemAdministratorWorkspaceAccess(access, "the System Error & Data Integrity Audit");

    const { eventId } = await context.params;
    if (!isUuid(eventId)) {
      return NextResponse.json({ error: "invalid_request", message: "That error id is not valid." }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data: row, error } = await supabase
      .from("app_error_events")
      .select("screenshot_path")
      .eq("id", eventId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: "unavailable", message: "The error row could not be read." }, { status: 500 });
    }
    const path = typeof row?.screenshot_path === "string" ? row.screenshot_path : null;
    if (!path) {
      return NextResponse.json({ error: "not_found", message: "No screenshot was taken for that error." }, { status: 404 });
    }

    const signed = await supabase.storage.from(ERROR_SCREENSHOT_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) {
      return NextResponse.json(
        { error: "unavailable", message: "The screenshot could not be opened." },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { url: signed.data.signedUrl, expiresInSeconds: SIGNED_URL_TTL_SECONDS },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "server_error", message: clientSafeErrorMessage(error, "The screenshot could not be opened.") },
      { status: 500 },
    );
  }
}
