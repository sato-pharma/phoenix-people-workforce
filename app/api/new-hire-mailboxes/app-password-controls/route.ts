/**
 * Capturing the app-passwords page's controls — a READ, and the only caller of
 * `describeAppPasswords`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A ROUTE EXISTS FOR A DIAGNOSTIC. `APP_PASSWORD_REVOKE_CONTROLS` in
 * `src/lib/mailbox-offboarding/robot/clear-app-passwords.ts` holds four `__UNCALIBRATED__`
 * placeholders — the list of existing app passwords, the control that removes one, its confirm, and
 * the empty state. Until they are real text, `APP_PASSWORD_CLEAR_CALIBRATED` cannot honestly be
 * flipped, and a leaver's phone and Outlook keep syncing mail after their password is reset. That is
 * the `isHalfRevoked` state the register already reports and nobody can close.
 *
 * The controls can only be seen from inside a mailbox, and nothing in Phoenix could get there: the
 * one read that exists runs AFTER minting inside `generateAppPassword`, which is reachable only
 * through a flow that RESETS the mailbox first — and a reset lands on the `Set up your mailbox
 * password` screen, whose submit IS the acceptance of Yahoo's terms of service and is therefore not
 * an automation's to give (2026-10-04). So the capture had no path.
 *
 * 🔴 THIS ROUTE TAKES THE OTHER PATH: IT SIGNS IN WITH A PASSWORD PHOENIX ALREADY HOLDS AND RESETS
 * NOTHING. A mailbox already past its first sign-in opens straight into its account pages. Nothing
 * is rotated, nothing is minted, no one-time password is left outstanding, and no revoke control is
 * pressed — the whole point is to read them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE ADDRESS IS NOT TAKEN FROM THE REQUEST. It is `INVITE_INBOX_ADDRESS`, the one mailbox Phoenix
 * owns and reads, for the same reason adoption compares rather than chooses: the same chain pointed
 * at an employee would sign into their mail. The body may ask for a dry run and nothing else.
 *
 * 🔴 AND THE RESPONSE IS THE DELIVERABLE, not the log line. The two live runs of 2026-10-03 stored
 * `adopted: false, refusal: null` and nothing else, and the diagnostic had to be copied out of a
 * browser by hand — so the controls come back in the response AND go to the log, and the audit row
 * carries them too. They are redacted before any of that: `buildControlReport` drops a
 * secret-shaped label whatever it is, and this page lists credentials by nature.
 */
import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canReadInitialPassword } from "@/lib/new-hire-mailbox/initial-password-store";
import { forwardToRobotService } from "@/lib/new-hire-mailbox/robot/actions/forward";
import { runAppPasswordControlsAction } from "@/lib/new-hire-mailbox/robot/actions/app-password-controls-action";
import { INVITE_INBOX_ADDRESS } from "@/lib/new-hire-mailbox/robot/invite-inbox";
import { robotServiceConfigured } from "@/lib/platform/robot-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError } from "@/lib/security/api-rate-limit";

// Required of every route by `scripts/check-routes.mjs`. The driver is puppeteer, so this cannot run
// on the edge; and a cached reading would be a stale answer about a live page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const blocked = assertSameOriginMutation(request);
  if (blocked) return blocked;

  try {
    const access = await resolveAccessContext(request);
    // The same audience as adoption, and the narrower reason: this signs in AS a mailbox with the
    // company password, so whoever may run it is already someone who may hold that password.
    if (!canReadInitialPassword(access.role)) {
      return NextResponse.json(
        {
          message:
            "Only the System Administrator can read the app-passwords page: it signs in as the "
            + "invite inbox with the password Phoenix holds for it.",
          success: false,
        },
        { status: 403 },
      );
    }

    // Only an explicit `false` opens a browser, so a malformed body plans rather than acts — the
    // same default every robot route here carries.
    const body = (await request.json().catch(() => ({}))) as { dryRun?: unknown };
    const dryRun = body?.dryRun !== false;

    if (dryRun) {
      return NextResponse.json({
        result: {
          address: INVITE_INBOX_ADDRESS,
          controls: [],
          dryRun: true,
          observed: 0,
          reached: false,
          redacted: 0,
          why:
            `Would sign in as ${INVITE_INBOX_ADDRESS} with the password Phoenix holds, open its `
            + "App Passwords page, and report the controls it finds. It would reset nothing, mint "
            + "nothing and press no remove control. Nothing was touched.",
        },
        success: true,
      });
    }

    await assertApiRateLimit({
      identifier: access.loginId ?? access.hrId ?? "unknown",
      limit: 3,
      scope: "new-hire-mailbox-app-password-controls",
      windowMs: 60 * 60_000,
    });

    // AFTER every check above, in the same order as before the robot service existed (audit
    // REC-075). The live run opens a robot browser, so once PHOENIX_ROBOT_SERVICE_URL is set it runs
    // on the robot service and its answer comes back unchanged; otherwise it runs here. Either way it
    // is the ONE implementation in runAppPasswordControlsAction, the company-password check and audit rows included.
    const actor = { hrId: access.hrId ?? null, loginId: access.loginId ?? null };
    if (robotServiceConfigured()) {
      return await forwardToRobotService({ action: "app-password-controls", actor, request: { dryRun: false } });
    }
    return await runAppPasswordControlsAction({ actor });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: "You do not have access to this.", success: false }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ message: error.message, success: false }, { status: 429 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The app-passwords page could not be read."), success: false },
      { status: 500 },
    );
  }
}
