import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canReadInitialPassword } from "@/lib/new-hire-mailbox/initial-password-store";
import { runAdoptAction } from "@/lib/new-hire-mailbox/robot/actions/adopt-action";
import { forwardToRobotService } from "@/lib/new-hire-mailbox/robot/actions/forward";
import { parseAdoptionRequest } from "@/lib/new-hire-mailbox/robot/adopt";
import { robotServiceConfigured } from "@/lib/platform/robot-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Adopt a mailbox that already exists: reset it in the Turbify console, then take its app password.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THIS IS THE ONLY CALLER OF ADOPTION, AND IT IS DELIBERATELY A HUMAN-TRIGGERED ROUTE RATHER
 * THAN A CRON. A reset locks a working employee out of webmail until somebody hands them the new
 * password, so the act needs a named person behind it and a row in the audit log saying who. The
 * joiner robot is the scheduled one, because a mailbox it has just created belongs to nobody yet;
 * nothing on a schedule may ever reach this path.
 *
 * 🔴 SUPER ADMIN ALONE — not `mailbox_offboarding:update`, which HR holds. The audience is exactly
 * the audience that can read the hand-over password (`canReadInitialPassword`), and for one reason:
 * whoever resets the mailbox is the only person who can then tell the employee how to get back in,
 * so splitting the two would produce a reset nobody could repair. The owner's instruction was the
 * System Administrator account only.
 *
 * 🔴 `dryRun` DEFAULTS TO TRUE. `parseAdoptionRequest` arms a live run only on the exact boolean
 * `false`, so a malformed or half-written request plans instead of resetting.
 *
 * The hand-over sentence comes back in the response; the password itself does not. It is sealed onto
 * the task row and read through the existing Super-Admin-only reveal path, so this route never puts
 * a mailbox password in a response body, a log line or an audit entry.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!canReadInitialPassword(access.role)) {
      return NextResponse.json(
        {
          message:
            "Only the System Administrator can adopt a mailbox: it resets the password of a mailbox "
            + "somebody is using, and whoever resets it has to be able to hand over the new one.",
          success: false,
        },
        { status: 403 },
      );
    }

    const parsed = parseAdoptionRequest(await request.json().catch(() => ({})));
    if (!parsed.ok) {
      return NextResponse.json({ message: parsed.message, success: false }, { status: 400 });
    }

    // Tight on purpose. A live pass resets real mailboxes, and a retry loop against this route would
    // lock out one employee after another; the limit bounds that rather than trusting the caller.
    // A dry run is a plan, so it is allowed to be run freely while deciding.
    if (!parsed.dryRun) {
      await assertApiRateLimit({
        identifier: access.loginId ?? access.hrId ?? "unknown",
        limit: 4,
        scope: "new-hire-mailbox-adopt",
        windowMs: 60 * 60_000,
      });
    }

    // AFTER every check above, in the same order as before the robot service existed (audit
    // REC-075). A LIVE run opens a robot browser, so once PHOENIX_ROBOT_SERVICE_URL is set it runs on
    // the robot service and its answer comes back unchanged; a dry run opens nothing and stays here.
    // Either way it is the ONE implementation in runAdoptAction, audit row included.
    const actor = { hrId: access.hrId ?? null, loginId: access.loginId ?? null };
    if (!parsed.dryRun && robotServiceConfigured()) {
      return await forwardToRobotService({
        action: "adopt",
        actor,
        request: { dryRun: parsed.dryRun, named: parsed.named },
      });
    }
    return await runAdoptAction({ actor, dryRun: parsed.dryRun, named: parsed.named });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: "You do not have access to this.", success: false }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ message: error.message, success: false }, { status: 429 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The adoption could not be run."), success: false },
      { status: 500 },
    );
  }
}
