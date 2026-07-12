import { NextResponse, type NextRequest } from "next/server";

import { createSystemNotification } from "@/lib/notifications/system";
import { writeAuditLog } from "@/lib/admin/audit";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-click "let the affected employee know we're on it". Deliberately IN-APP ONLY (no
// email/telegram) and template-free — a single reassuring message that the team is aware.
// The client requires an explicit confirmation before calling this. CEO + Super Admin only.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { hrId?: unknown; moduleLabel?: unknown; route?: unknown };
    const hrId = typeof body.hrId === "string" ? body.hrId.trim() : "";
    if (!hrId) {
      return NextResponse.json({ message: "hrId is required." }, { status: 400 });
    }
    const moduleLabel = typeof body.moduleLabel === "string" ? body.moduleLabel.slice(0, 120) : "";
    const route = typeof body.route === "string" ? body.route.slice(0, 300) : "";

    await createSystemNotification({
      actionUrl: route && route.startsWith("/") ? route : "/employee-portals",
      channels: ["in_app"],
      eventType: "system_issue_flagged",
      message: `Our team noticed a technical issue affecting you${moduleLabel ? ` on ${moduleLabel}` : ""}. We're already looking into it — thanks for your patience.`,
      module: "system",
      priority: "normal",
      recipientHrId: hrId,
      subjectHrId: hrId,
      title: "We're aware of a technical issue",
    });

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: hrId,
      entityType: "notification",
      summary: `${access.hrId ?? "admin"} sent a system-issue in-app notice to ${hrId}${moduleLabel ? ` (${moduleLabel})` : ""}.`,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to notify employee." },
      { status: 500 },
    );
  }
}
