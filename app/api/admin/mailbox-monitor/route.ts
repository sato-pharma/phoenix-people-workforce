import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { addMonitor, listMonitors, MailboxMonitorError } from "@/lib/mailbox-monitor/service";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mailbox compliance monitor — list + add. Super Admin only (mailbox_monitor permission, a hard
// boundary). imapflow needs the Node runtime.

export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "read");
    const monitors = await listMonitors();
    return NextResponse.json({ monitors });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load monitored mailboxes.") },
      { status: 500 },
    );
  }
}

type AddBody = {
  emailAddress?: unknown;
  appPassword?: unknown;
  employeeHrId?: unknown;
  displayLabel?: unknown;
  imapHost?: unknown;
  imapPort?: unknown;
  imapSecure?: unknown;
};

export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_monitor", "update");

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "mailbox-monitor:add",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as AddBody;
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
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { message: "Too many attempts — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    if (error instanceof MailboxMonitorError) {
      return NextResponse.json({ message: error.message }, { status: error.statusCode });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to add the mailbox.") },
      { status: 500 },
    );
  }
}
