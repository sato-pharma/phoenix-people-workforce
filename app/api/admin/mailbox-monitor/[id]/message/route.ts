import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  mailboxMonitorErrorResponse,
  type MailboxMonitorRouteAccess,
} from "@/lib/mailbox-monitor/route-errors";
import { assertMailboxImapCeiling } from "@/lib/mailbox-monitor/route-limits";
import { openMonitorMessage } from "@/lib/mailbox-monitor/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Open one message (full body). Read-only / peek — opening a message here does not set \Seen in the
// owner's mailbox, so it stays unread for them.
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // Hoisted out of the try so the catch can say WHO hit the failure — see the note on the GET in
  // app/api/admin/mailbox-monitor/route.ts.
  let access: MailboxMonitorRouteAccess = null;
  try {
    access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "read");
    const { id } = await context.params;
    const folder = request.nextUrl.searchParams.get("folder") || "INBOX";
    const uid = Number(request.nextUrl.searchParams.get("uid"));
    if (!Number.isFinite(uid) || uid <= 0) {
      return NextResponse.json({ message: "A valid message uid is required." }, { status: 400 });
    }
    // Reading a message is one more live login, and it is the one an admin repeats fastest — a
    // click per row down a folder listing. route-limits.ts holds the reason all five paths are
    // bounded, not just the one that paid for it.
    await assertMailboxImapCeiling({
      actor: access.loginId ?? access.hrId,
      monitorId: id,
      request,
      scope: "mailbox-monitor:open-message",
    });
    const message = await openMonitorMessage(id, folder, uid, access.hrId ?? access.loginId ?? null);
    if (!message) return NextResponse.json({ message: "That message no longer exists." }, { status: 404 });
    return NextResponse.json({ message });
  } catch (error) {
    return mailboxMonitorErrorResponse({
      access,
      error,
      fallbackMessage: "Failed to open the message.",
      request,
      route: "/api/admin/mailbox-monitor/[id]/message",
    });
  }
}
