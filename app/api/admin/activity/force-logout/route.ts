export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { resolveAccessContext, isForbiddenError } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { writeAuditLog } from "@/lib/admin/audit";
import { forceLogoutUser } from "@/lib/activity/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ message: "Not authenticated" }, { status: 401 });
    }
    await assertPermission(access, "user_activity", "export");

    let body: { hrId?: string; reason?: string };
    try {
      body = (await request.json()) as { hrId?: string; reason?: string };
    } catch {
      return NextResponse.json({ message: "Invalid request body" }, { status: 400 });
    }

    const { hrId, reason = "Admin-initiated force logout" } = body;
    if (!hrId || typeof hrId !== "string") {
      return NextResponse.json({ message: "hrId is required" }, { status: 400 });
    }

    const result = await forceLogoutUser(hrId, reason);

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "user_activity_access",
      entityId: hrId,
      summary: `Force-logout: revoked ${result.revokedCount} session(s) for ${hrId}. Reason: ${reason}`,
    });

    return NextResponse.json({ ok: true, revokedCount: result.revokedCount });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: "Forbidden" }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Force logout failed");
    return NextResponse.json({ message }, { status: 500 });
  }
}
