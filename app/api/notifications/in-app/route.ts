import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  archiveAllInAppNotifications,
  listInAppNotificationsForViewer,
  markAllInAppNotificationsRead,
  markInAppNotificationRead,
} from "@/lib/notifications/in-app";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `?limit=` — how many of the newest notices the caller is willing to render.
 *
 * The bell asks for the service's default 8, which is what its panel shows. The identity band on the
 * landing page groups notices of one kind into a single block carrying a COUNT, so a default of 8
 * would under-report a kind that fired nine times — it asks for 20.
 *
 * It is not a trust boundary and cannot become one: `listInAppNotificationsForViewer` clamps its own
 * limit to `Math.max(1, Math.min(limit, 20))`, and the viewer, the personal-bell allowlist and the
 * test-login fence are all resolved server-side from the access context, never from the query. A
 * missing, non-numeric or out-of-range value falls back to the service default rather than erroring,
 * because a malformed URL must not cost the caller its notices.
 */
function requestedLimit(request: Request) {
  const raw = new URL(request.url).searchParams.get("limit");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 20) : undefined;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ data: [], success: true });
    }

    const limit = requestedLimit(request);
    const notifications =
      limit === undefined
        ? await listInAppNotificationsForViewer(access)
        : await listInAppNotificationsForViewer(access, limit);
    return NextResponse.json({ data: notifications, success: true });
  } catch (error) {
    console.error("GET /api/notifications/in-app failed", error);
    const message = clientSafeErrorMessage(error, "Unable to load notifications.");
    return NextResponse.json({ error: "notification_load_failed", message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    if (body.markAll === true) {
      return NextResponse.json({ data: await markAllInAppNotificationsRead(access), success: true });
    }
    if (body.clearAll === true) {
      return NextResponse.json({ data: await archiveAllInAppNotifications(access), success: true });
    }

    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return NextResponse.json({ error: "missing_notification_id" }, { status: 400 });
    return NextResponse.json({ data: await markInAppNotificationRead(access, id), success: true });
  } catch (error) {
    console.error("PATCH /api/notifications/in-app failed", error);
    const message = clientSafeErrorMessage(error, "Unable to update notification.");
    return NextResponse.json({ error: "notification_update_failed", message }, { status: 500 });
  }
}
