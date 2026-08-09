import { NextResponse, type NextRequest } from "next/server";

import { blockIp, unblockIp } from "@/lib/auth/ip-blocklist";
import { writeAuditLog } from "@/lib/admin/audit";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Blocking/unblocking an IP changes who can authenticate, so this is SUPER ADMIN ONLY
// (not the CEO+SA gate the read-only security lens uses). CSRF-guarded and audited.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canAccessSystemAdministratorWorkspace(access)) {
      return NextResponse.json({ message: "Forbidden: Super Admin only." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { ip?: unknown; reason?: unknown; days?: unknown; action?: unknown };
    const ip = typeof body.ip === "string" ? body.ip.trim() : "";
    if (!ip) {
      return NextResponse.json({ message: "ip is required." }, { status: 400 });
    }
    const action = body.action === "unblock" ? "unblock" : "block";

    if (action === "unblock") {
      await unblockIp(ip);
      await writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: ip,
        entityType: "auth_session",
        summary: `${access.hrId ?? "admin"} unblocked login IP ${ip}.`,
      });
      return NextResponse.json({ ok: true });
    }

    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
    const days = body.days === null ? null : typeof body.days === "number" ? body.days : undefined;
    await blockIp({ blockedBy: access.hrId, days, ip, reason });
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: ip,
      entityType: "auth_session",
      summary: `${access.hrId ?? "admin"} blocked login IP ${ip}${reason ? ` (${reason})` : ""}.`,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to update IP blocklist.") },
      { status: 500 },
    );
  }
}
