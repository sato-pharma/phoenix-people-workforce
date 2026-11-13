/**
 * The app-password rehearsal — mint one, read the page at every stage, remove it again.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A SECOND ROUTE AND NOT A MODE ON THE CAPTURE. `app-password-controls` is documented, named and
 * tested as a READ: it resets nothing, mints nothing and presses no revoke control. This one mints a
 * live credential. Folding a mutation into a route whose whole contract is "this changes nothing"
 * is how a reader ends up trusting the wrong sentence — so they stay apart, and the capture's
 * promise stays true.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS FOR. `APP_PASSWORD_REVOKE_CONTROLS` holds four placeholders. The live capture of
 * 2026-10-04 10:30 Cairo filled one and could never fill `removeConfirm`, because that control does
 * not exist until Remove has been pressed — it is not a wording nobody has looked up, it is a
 * wording that is not on the page until you act. Minting something in order to remove it is the only
 * way to see it, and this is that run.
 *
 * 🔴 THE ADDRESS IS NOT TAKEN FROM THE REQUEST, and the driver refuses any other one before it opens
 * a browser. It is `INVITE_INBOX_ADDRESS` — Phoenix's own invite inbox, which holds nobody's mail.
 * The same sequence aimed at an employee would mint and revoke a credential on the mailbox their
 * phone is syncing.
 *
 * 🔴 AND `outstanding` IS THE FIELD TO READ FIRST. A rehearsal that minted and then could not press
 * an unknown confirm has left a WORKING app password on that mailbox. Reporting only `removed:
 * false` would read as "nothing happened", which is the opposite of what occurred, so the flag, the
 * summary and the response all say it in words.
 */
import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canReadInitialPassword } from "@/lib/new-hire-mailbox/initial-password-store";
import { forwardToRobotService } from "@/lib/new-hire-mailbox/robot/actions/forward";
import { runAppPasswordRehearsalAction } from "@/lib/new-hire-mailbox/robot/actions/app-password-rehearsal-action";
import { INVITE_INBOX_ADDRESS } from "@/lib/new-hire-mailbox/robot/invite-inbox";
import { robotServiceConfigured } from "@/lib/platform/robot-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError } from "@/lib/security/api-rate-limit";

// Required of every route by `scripts/check-routes.mjs`. Puppeteer cannot run on the edge, and a
// cached answer about a live mailbox would be worse than none.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const blocked = assertSameOriginMutation(request);
  if (blocked) return blocked;

  try {
    const access = await resolveAccessContext(request);
    if (!canReadInitialPassword(access.role)) {
      return NextResponse.json(
        {
          message:
            "Only the System Administrator can run the app-password rehearsal: it signs in as the "
            + "invite inbox with the password Phoenix holds for it, and mints a real app password.",
          success: false,
        },
        { status: 403 },
      );
    }

    // Only an explicit `false` opens a browser. A malformed body plans rather than mints — and here
    // that default is load-bearing rather than tidy, because the live path creates a credential.
    const body = (await request.json().catch(() => ({}))) as { dryRun?: unknown };
    const dryRun = body?.dryRun !== false;

    if (dryRun) {
      return NextResponse.json({
        result: {
          address: INVITE_INBOX_ADDRESS,
          dryRun: true,
          minted: false,
          outstanding: false,
          removed: false,
          why:
            `Would sign in as ${INVITE_INBOX_ADDRESS}, open its App Passwords page, read it, mint ONE `
            + "app password, read the page again, press Remove, read the confirm step, answer it, and "
            + "read the page a final time. It touches no other mailbox. If the confirm cannot be "
            + "matched — which is the expected outcome the first time, because nothing has ever seen "
            + "that control — a working app password is left on the invite inbox and the answer says "
            + "so. Nothing was touched by this call.",
        },
        success: true,
      });
    }

    // Tighter than the capture's three, because every live run of this one creates a credential.
    await assertApiRateLimit({
      identifier: access.loginId ?? access.hrId ?? "unknown",
      limit: 2,
      scope: "new-hire-mailbox-app-password-rehearsal",
      windowMs: 60 * 60_000,
    });

    // AFTER every check above, in the same order as before the robot service existed (audit
    // REC-075). The live run opens a robot browser, so once PHOENIX_ROBOT_SERVICE_URL is set it runs
    // on the robot service and its answer comes back unchanged; otherwise it runs here. Either way it
    // is the ONE implementation in runAppPasswordRehearsalAction, the company-password check and audit rows included.
    const actor = { hrId: access.hrId ?? null, loginId: access.loginId ?? null };
    if (robotServiceConfigured()) {
      return await forwardToRobotService({ action: "app-password-rehearsal", actor, request: { dryRun: false } });
    }
    return await runAppPasswordRehearsalAction({ actor });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: "You do not have access to this.", success: false }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ message: error.message, success: false }, { status: 429 });
    }
    return NextResponse.json(
      {
        message: clientSafeErrorMessage(error, "The app-password rehearsal could not be completed."),
        success: false,
      },
      { status: 500 },
    );
  }
}
