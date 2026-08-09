import { NextResponse, type NextRequest } from "next/server";

import { resolveAccessContext, isForbiddenError } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { assertCanViewEmployeeActivity, buildActivityRange, getUserTimeline } from "@/lib/activity/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    await assertPermission(access, "user_activity", "read");

    const url = new URL(request.url);
    const hrId = url.searchParams.get("hrId")?.trim();
    const days = Number(url.searchParams.get("days") ?? "7");
    if (!hrId) {
      return NextResponse.json({ error: "validation_error", message: "hrId is required." }, { status: 400 });
    }
    await assertCanViewEmployeeActivity(access, hrId);

    const range = buildActivityRange(days);
    const timeline = await getUserTimeline(hrId, range);
    if (!timeline) {
      return NextResponse.json({ error: "not_found", message: "No activity found for this employee." }, { status: 404 });
    }

    // Audit-the-auditor: record who looked at whose activity.
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "user_activity_access",
      entityId: hrId,
      summary: `Viewed activity timeline for ${hrId} (last ${range.days} days)`,
    });

    return NextResponse.json({ timeline });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden") }, { status: 403 });
    }
    console.error("[activity] timeline error", error);
    return NextResponse.json({ error: "server_error", message: "Failed to load activity timeline." }, { status: 500 });
  }
}
