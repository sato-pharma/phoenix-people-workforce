/**
 * Reading ONE leaver's mailbox Edit form in the Turbify console — a READ, and the only caller of
 * `captureMailboxEditForm` (13 Nov 2026).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS. The leaver register resets a leaver's mailbox password, and Turbify app passwords
 * survive a reset. Clearing them from inside the mailbox is permanently blocked: after a reset the
 * mailbox's setup page's submit is the acceptance of Yahoo's terms, which an automation never gives.
 * The console's per-mailbox row offers Add alias, Reset password, Edit and a More actions menu
 * (Reset password, Edit, Transfer account, Delete) — no suspend. The owner chose to look inside Edit
 * once, read-only, to see whether it carries an on/off, status or access switch that would cut a
 * leaver off. This route is that look.
 *
 * 🔴 IT CHANGES NOTHING. The driver signs in as the administrator, searches, presses the ONE row's
 * Edit whose own address cell equals the address, reads the form, and leaves it with Close modal,
 * Cancel, Close or Escape — never a control that keeps a change. A text field comes back as a
 * LENGTH, never a value.
 *
 * 🔴 THE ORDER OF THE REFUSALS IS THE SAFETY PROPERTY:
 *   1. the System Administrator gate, BEFORE the body is read;
 *   2. the address must be a leaver on the register (exact, lowered) — BEFORE a browser exists;
 *   3. the rate limit, then the run — forwarded to the robot service when it is switched on.
 * Every run that reaches the driver is audited, a failed one included; no email is sent.
 */
import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { findLeaverOnRegister } from "@/lib/mailbox-offboarding/service";
import { canReadInitialPassword } from "@/lib/new-hire-mailbox/initial-password-store";
import { runEditFormControlsAction } from "@/lib/new-hire-mailbox/robot/actions/edit-form-controls-action";
import { forwardToRobotService } from "@/lib/new-hire-mailbox/robot/actions/forward";
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
    // The same audience as the app-password capture: this signs the console administrator in, so
    // whoever may run it is the System Administrator alone. Refused BEFORE the body is read.
    if (!canReadInitialPassword(access.role)) {
      return NextResponse.json(
        {
          message:
            "Only the System Administrator can read a mailbox's Edit form: it signs in to the Turbify "
            + "console as its administrator.",
          success: false,
        },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { address?: unknown };
    const asked = typeof body?.address === "string" ? body.address.trim().toLowerCase() : "";
    if (!asked.includes("@")) {
      return NextResponse.json(
        { message: "Choose a leaver first. Nothing was opened.", success: false },
        { status: 400 },
      );
    }

    // 🔴 ONLY A LEAVER ON THE REGISTER, and refused before any browser is built: a colleague still at
    // work is not this capture's business. Exact lowered match — `el.sayed@` never matches `adel.sayed@`.
    const leaver = await findLeaverOnRegister(asked);
    if (!leaver) {
      return NextResponse.json(
        {
          message: "That address is not a leaver on the mailbox register, so nothing was opened.",
          success: false,
        },
        { status: 404 },
      );
    }

    await assertApiRateLimit({
      identifier: access.loginId ?? access.hrId ?? "unknown",
      limit: 3,
      scope: "mailbox-offboarding-edit-form-controls",
      windowMs: 60 * 60_000,
    });

    // AFTER every check above (audit REC-075). The live run opens a robot browser, so once
    // PHOENIX_ROBOT_SERVICE_URL is set it runs on the robot service and its answer comes back
    // unchanged; otherwise it runs here. Either way it is the ONE implementation in
    // runEditFormControlsAction, its own register check and both audit rows included.
    const actor = { hrId: access.hrId ?? null, loginId: access.loginId ?? null };
    if (robotServiceConfigured()) {
      return await forwardToRobotService({ action: "edit-form-controls", actor, request: { address: leaver.workEmail } });
    }
    return await runEditFormControlsAction({ actor, address: leaver.workEmail });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: "You do not have access to this.", success: false }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ message: error.message, success: false }, { status: 429 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The Edit form could not be read."), success: false },
      { status: 500 },
    );
  }
}
