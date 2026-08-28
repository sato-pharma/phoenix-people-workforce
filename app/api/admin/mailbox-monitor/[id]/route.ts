import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  deleteMonitor,
  listMonitorFolders,
  MailboxMonitorError,
  recheckMonitor,
} from "@/lib/mailbox-monitor/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Opening a monitored mailbox lists its folders (a live, read-only IMAP call, audited).
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "read");
    const { id } = await context.params;
    const folders = await listMonitorFolders(id, access.hrId ?? access.loginId ?? null);
    return NextResponse.json({ folders });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    if (error instanceof MailboxMonitorError) return NextResponse.json({ message: error.message }, { status: error.statusCode });
    return NextResponse.json({ message: clientSafeErrorMessage(error, "Failed to open the mailbox.") }, { status: 500 });
  }
}

// Re-test the stored credential and refresh health.
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "update");
    const { id } = await context.params;
    const monitor = await recheckMonitor(id, access.hrId ?? access.loginId ?? null);
    return NextResponse.json({ monitor, ok: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    if (error instanceof MailboxMonitorError) return NextResponse.json({ message: error.message }, { status: error.statusCode });
    return NextResponse.json({ message: clientSafeErrorMessage(error, "Failed to re-check the mailbox.") }, { status: 500 });
  }
}

// Remove a monitored mailbox (deletes the stored credential; the access log survives).
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "update");
    const { id } = await context.params;
    await deleteMonitor(id, access.hrId ?? access.loginId ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    if (error instanceof MailboxMonitorError) return NextResponse.json({ message: error.message }, { status: error.statusCode });
    return NextResponse.json({ message: clientSafeErrorMessage(error, "Failed to remove the mailbox.") }, { status: 500 });
  }
}
