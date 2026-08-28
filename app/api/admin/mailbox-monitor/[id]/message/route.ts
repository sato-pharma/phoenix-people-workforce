import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { openMonitorMessage, MailboxMonitorError } from "@/lib/mailbox-monitor/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Open one message (full body). Read-only / peek — opening a message here does not set \Seen in the
// owner's mailbox, so it stays unread for them.
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "read");
    const { id } = await context.params;
    const folder = request.nextUrl.searchParams.get("folder") || "INBOX";
    const uid = Number(request.nextUrl.searchParams.get("uid"));
    if (!Number.isFinite(uid) || uid <= 0) {
      return NextResponse.json({ message: "A valid message uid is required." }, { status: 400 });
    }
    const message = await openMonitorMessage(id, folder, uid, access.hrId ?? access.loginId ?? null);
    if (!message) return NextResponse.json({ message: "That message no longer exists." }, { status: 404 });
    return NextResponse.json({ message });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    if (error instanceof MailboxMonitorError) return NextResponse.json({ message: error.message }, { status: error.statusCode });
    return NextResponse.json({ message: clientSafeErrorMessage(error, "Failed to open the message.") }, { status: 500 });
  }
}
