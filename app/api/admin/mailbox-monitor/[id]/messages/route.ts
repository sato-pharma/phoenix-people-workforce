import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listMonitorMessages, MailboxMonitorError } from "@/lib/mailbox-monitor/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List the most recent messages in a folder (envelopes only). Read-only / peek — does not mark
// anything read in the owner's mailbox.
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "read");
    const { id } = await context.params;
    const folder = request.nextUrl.searchParams.get("folder") || "INBOX";
    const limitRaw = Number(request.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const messages = await listMonitorMessages(id, folder, access.hrId ?? access.loginId ?? null, limit);
    return NextResponse.json({ folder, messages });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    if (error instanceof MailboxMonitorError) return NextResponse.json({ message: error.message }, { status: error.statusCode });
    return NextResponse.json({ message: clientSafeErrorMessage(error, "Failed to list messages.") }, { status: 500 });
  }
}
