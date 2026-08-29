import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  mailboxMonitorErrorResponse,
  type MailboxMonitorRouteAccess,
} from "@/lib/mailbox-monitor/route-errors";
import {
  addMonitor,
  importConfiguredMailboxes,
  listImportableMailboxes,
  listMonitors,
} from "@/lib/mailbox-monitor/service";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mailbox compliance monitor — list + add. Super Admin only (mailbox_monitor permission, a hard
// boundary). imapflow needs the Node runtime.

export async function GET(request: NextRequest) {
  // Hoisted out of the try so the catch can say WHO hit the failure. Resolved inside, a throw at or
  // before this line would leave the recorded row with no actor — and "someone, somewhere" is the
  // state this logging exists to end.
  let access: MailboxMonitorRouteAccess = null;
  try {
    access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "read");
    const [monitors, importable] = await Promise.all([listMonitors(), listImportableMailboxes()]);
    return NextResponse.json({ importable, monitors });
  } catch (error) {
    return mailboxMonitorErrorResponse({
      access,
      error,
      fallbackMessage: "Failed to load monitored mailboxes.",
      request,
      route: "/api/admin/mailbox-monitor",
    });
  }
}

type AddBody = {
  // When true, ignore the fields below and import every already-configured company mailbox
  // (careers@ / hr@) that is not yet monitored, reusing the credential Phoenix already holds.
  importConfigured?: unknown;
  emailAddress?: unknown;
  appPassword?: unknown;
  employeeHrId?: unknown;
  displayLabel?: unknown;
  imapHost?: unknown;
  imapPort?: unknown;
  imapSecure?: unknown;
};

export async function POST(request: NextRequest) {
  let access: MailboxMonitorRouteAccess = null;
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "update");

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "mailbox-monitor:add",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as AddBody;

    // Import path: no password crosses the wire — the credential already lives in the server's
    // environment. Same permission, CSRF and rate limit as a manual add.
    if (body.importConfigured === true) {
      const result = await importConfiguredMailboxes(access.hrId ?? access.loginId ?? null);
      return NextResponse.json({ ...result, ok: true });
    }

    const monitor = await addMonitor(
      {
        appPassword: typeof body.appPassword === "string" ? body.appPassword : "",
        displayLabel: typeof body.displayLabel === "string" ? body.displayLabel : null,
        emailAddress: typeof body.emailAddress === "string" ? body.emailAddress : "",
        employeeHrId: typeof body.employeeHrId === "string" ? body.employeeHrId : null,
        imapHost: typeof body.imapHost === "string" ? body.imapHost : undefined,
        imapPort: typeof body.imapPort === "number" ? body.imapPort : undefined,
        imapSecure: typeof body.imapSecure === "boolean" ? body.imapSecure : undefined,
      },
      access.hrId ?? access.loginId ?? null,
    );
    return NextResponse.json({ monitor, ok: true });
  } catch (error) {
    return mailboxMonitorErrorResponse({
      access,
      error,
      fallbackMessage: "Failed to add the mailbox.",
      request,
      route: "/api/admin/mailbox-monitor",
    });
  }
}
