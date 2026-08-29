import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  mailboxMonitorErrorResponse,
  type MailboxMonitorRouteAccess,
} from "@/lib/mailbox-monitor/route-errors";
import { deleteMonitor, listMonitorFolders, recheckMonitor } from "@/lib/mailbox-monitor/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Opening a monitored mailbox lists its folders (a live, read-only IMAP call, audited).
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // Hoisted out of the try so the catch can say WHO hit the failure — see the note on the GET in
  // app/api/admin/mailbox-monitor/route.ts.
  let access: MailboxMonitorRouteAccess = null;
  try {
    access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "read");
    const { id } = await context.params;
    const folders = await listMonitorFolders(id, access.hrId ?? access.loginId ?? null);
    return NextResponse.json({ folders });
  } catch (error) {
    return mailboxMonitorErrorResponse({
      access,
      error,
      fallbackMessage: "Failed to open the mailbox.",
      request,
      route: "/api/admin/mailbox-monitor/[id]",
    });
  }
}

// Re-test the stored credential and refresh health.
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let access: MailboxMonitorRouteAccess = null;
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "update");
    const { id } = await context.params;
    const monitor = await recheckMonitor(id, access.hrId ?? access.loginId ?? null);
    return NextResponse.json({ monitor, ok: true });
  } catch (error) {
    return mailboxMonitorErrorResponse({
      access,
      error,
      fallbackMessage: "Failed to re-check the mailbox.",
      request,
      route: "/api/admin/mailbox-monitor/[id]",
    });
  }
}

// Remove a monitored mailbox (deletes the stored credential; the access log survives).
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let access: MailboxMonitorRouteAccess = null;
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "update");
    const { id } = await context.params;
    await deleteMonitor(id, access.hrId ?? access.loginId ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return mailboxMonitorErrorResponse({
      access,
      error,
      fallbackMessage: "Failed to remove the mailbox.",
      request,
      route: "/api/admin/mailbox-monitor/[id]",
    });
  }
}
