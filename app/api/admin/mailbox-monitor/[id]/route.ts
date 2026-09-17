import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  mailboxMonitorErrorResponse,
  type MailboxMonitorRouteAccess,
} from "@/lib/mailbox-monitor/route-errors";
import { assertMailboxImapCeiling } from "@/lib/mailbox-monitor/route-limits";
import {
  deleteMonitor,
  listMonitorFolders,
  recheckMonitor,
  replaceMonitorPassword,
} from "@/lib/mailbox-monitor/service";
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
    // Opening a mailbox is a live IMAP login with the stored credential, and this row may be one
    // whose app password was revoked — the button stays enabled on a failing row. route-limits.ts
    // holds the reason every one of these paths has to be bounded, not just the one that paid for it.
    await assertMailboxImapCeiling({
      actor: access.loginId ?? access.hrId,
      monitorId: id,
      request,
      scope: "mailbox-monitor:open",
    });
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

type PatchBody = {
  // Present: replace the stored app password with this one. Absent (the bare PATCH the Re-check
  // button sends): re-test the credential the row already holds.
  appPassword?: unknown;
};

// Update a monitor. Two shapes, both mailbox_monitor:update and both CSRF-guarded:
//   PATCH with no body            → re-test the stored credential and refresh health.
//   PATCH { appPassword: "..." }  → prove a new app password, then store it in place of the old.
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let access: MailboxMonitorRouteAccess = null;
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "update");
    const { id } = await context.params;
    const actorHrId = access.hrId ?? access.loginId ?? null;

    // The Re-check button sends no body at all, so the parse is expected to fail on that path —
    // `.catch` rather than a try block, which would also swallow the failures below it. `body` is
    // read through `?.` because a literal `null` IS valid JSON: it parses, so the catch never runs,
    // and reading a property off it threw a TypeError that came back as a raw 500.
    const body = (await request.json().catch(() => ({}))) as PatchBody | null;
    const appPassword = typeof body?.appPassword === "string" ? body.appPassword : "";

    if (appPassword) {
      // Each attempt is a live IMAP login against a real mailbox. Yahoo locks an account out after
      // enough failures, so a mistyped password must not be retryable at machine speed — same
      // ceiling as the add path, which lands at the same place for the same reason.
      await assertMailboxImapCeiling({
        actor: access.loginId ?? access.hrId,
        monitorId: id,
        request,
        scope: "mailbox-monitor:replace-password",
      });
      const replaced = await replaceMonitorPassword(id, appPassword, actorHrId);
      return NextResponse.json({ monitor: replaced, ok: true });
    }

    // A bare re-check is a live login too — and it is the button an admin clicks REPEATEDLY on a
    // mailbox that is already failing, which is precisely the sequence that locks the account out.
    await assertMailboxImapCeiling({
      actor: access.loginId ?? access.hrId,
      monitorId: id,
      request,
      scope: "mailbox-monitor:recheck",
    });
    const monitor = await recheckMonitor(id, actorHrId);
    return NextResponse.json({ monitor, ok: true });
  } catch (error) {
    return mailboxMonitorErrorResponse({
      access,
      error,
      fallbackMessage: "Failed to update the mailbox.",
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
