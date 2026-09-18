import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import {
  connectNewHireMailboxTask,
  dismissNewHireMailboxTask,
  NewHireMailboxError,
} from "@/lib/new-hire-mailbox/service";
import { PersonalMailboxError } from "@/lib/personal-mailbox/rules";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connect a new hire's company mailbox to their My email, or rule that they need none.
 *
 * Gated on `mailbox_offboarding:update` — the same grant as Mailbox Revocation, because creating a
 * joiner's mailbox and shutting a leaver's are the two ends of one job. The app password in the body
 * goes to the domain service and nowhere else: it is never logged, audited or sent back.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "mailbox_offboarding", "update");

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      appPassword?: unknown;
      emailAddress?: unknown;
      hrId?: unknown;
      note?: unknown;
    };
    const hrId = typeof body.hrId === "string" ? body.hrId.trim() : "";
    if (!hrId) {
      return NextResponse.json({ message: "Choose the new hire this is about.", success: false }, { status: 400 });
    }

    if (body.action === "dismiss") {
      const note = typeof body.note === "string" ? body.note : null;
      await dismissNewHireMailboxTask({ actorHrId: access.hrId ?? null, hrId, note });
      await writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: hrId,
        entityType: "new_hire_mailbox",
        newValues: { note, status: "not_needed" },
        summary: `Recorded that ${hrId} needs no company mailbox`,
      });
      return NextResponse.json({ status: "not_needed", success: true });
    }

    if (body.action !== "connect") {
      return NextResponse.json({ message: "Action must be connect or dismiss.", success: false }, { status: 400 });
    }

    // Each try is two real logins on the new mailbox, and Yahoo locks a mailbox after enough
    // failures — so a stuck button can spend only a handful, per new hire.
    await assertApiRateLimit({
      identifier: `hire:${hrId.toLowerCase()}`,
      limit: 5,
      scope: "new-hire-mailbox:connect",
      windowMs: 10 * 60_000,
    });

    const outcome = await connectNewHireMailboxTask({
      actorHrId: access.hrId ?? null,
      appPassword: typeof body.appPassword === "string" ? body.appPassword : "",
      emailAddress: typeof body.emailAddress === "string" ? body.emailAddress : null,
      hrId,
    });

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: hrId,
      entityType: "new_hire_mailbox",
      newValues: {
        alreadyConnected: outcome.alreadyConnected,
        emailAddress: outcome.emailAddress,
        status: "connected",
        workEmailUpdated: outcome.workEmailUpdated,
      },
      summary: `Connected ${outcome.emailAddress} to ${outcome.displayName}'s My email`,
    });

    return NextResponse.json({ ...outcome, status: "connected", success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: "You do not have access to new hire mailboxes.", success: false }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { message: "Too many tries for this person — wait ten minutes before trying again.", success: false },
        { status: 429 },
      );
    }
    if (error instanceof NewHireMailboxError || error instanceof PersonalMailboxError) {
      return NextResponse.json({ message: error.message, success: false }, { status: error.statusCode });
    }
    const message = clientSafeErrorMessage(error, "The new hire's mailbox could not be saved.");
    return NextResponse.json({ message, success: false }, { status: 500 });
  }
}
