import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  mailboxMonitorErrorResponse,
  type MailboxMonitorRouteAccess,
} from "@/lib/mailbox-monitor/route-errors";
import { listMonitorMessages } from "@/lib/mailbox-monitor/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List the most recent messages in a folder (envelopes only). Read-only / peek — does not mark
// anything read in the owner's mailbox.
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // Hoisted out of the try so the catch can say WHO hit the failure — see the note on the GET in
  // app/api/admin/mailbox-monitor/route.ts.
  let access: MailboxMonitorRouteAccess = null;
  try {
    access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "read");
    const { id } = await context.params;
    const folder = request.nextUrl.searchParams.get("folder") || "INBOX";
    const limitRaw = Number(request.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const messages = await listMonitorMessages(id, folder, access.hrId ?? access.loginId ?? null, limit);
    return NextResponse.json({ folder, messages });
  } catch (error) {
    return mailboxMonitorErrorResponse({
      access,
      error,
      fallbackMessage: "Failed to list messages.",
      request,
      route: "/api/admin/mailbox-monitor/[id]/messages",
    });
  }
}
