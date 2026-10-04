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

import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canReadInitialPassword } from "@/lib/new-hire-mailbox/initial-password-store";
import type { AppPasswordPageReading } from "@/lib/new-hire-mailbox/robot/driver";
import { INVITE_INBOX_ADDRESS } from "@/lib/new-hire-mailbox/robot/invite-inbox";
import { readCompanyInitialPassword } from "@/lib/new-hire-mailbox/robot/initial-password";
import { createJoinerDriverFromEnv } from "@/lib/new-hire-mailbox/robot/sweep-deps";
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

    const companyPassword = String((await readCompanyInitialPassword()) ?? "");
    if (companyPassword.length === 0) {
      // Refused before a browser is opened. Without a password there is nothing to sign in with,
      // and the alternative — reaching the login form and failing there — would look like a wrong
      // password on a live mailbox.
      return NextResponse.json(
        {
          message:
            "PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD is not set, so there is no password to sign in "
            + "with. Nothing was opened.",
          success: false,
        },
        { status: 409 },
      );
    }

    const driver = await createJoinerDriverFromEnv();
    let reading: AppPasswordPageReading;
    try {
      try {
        reading = await driver.describeAppPasswords({ address: INVITE_INBOX_ADDRESS, password: companyPassword });
      } finally {
        // The browser is closed whatever happened: a leaked Chromium in the container outlives the
        // request and holds a signed-in mailbox session. It closes BEFORE the audit below, so a slow
        // or failing insert never holds a signed-in session open behind it.
        await driver.close().catch(() => {});
      }
    } catch (error) {
      // 🔴 A RUN THAT THREW IS RECORDED TOO, AND THIS IS THE HALF THAT WAS MISSING. The first live
      // run (2026-10-04 07:16 Cairo) refused inside `signInAs` — the sign-in never left Turbify's
      // login page — and the throw sailed past the audit below, so the ONLY account of it was the
      // text on the card. One reload would have erased the finding, exactly as a `router.refresh()`
      // did to a failed Turbify run on 2026-10-03.
      //
      // The message is what carries the value: it holds the measured page — its url, title,
      // headings, buttons and controls, with every `filled` already reduced to a LENGTH and every
      // secret-shaped value dropped. It is the same string the card shows, so storing it is exactly
      // as safe as rendering it, and it is what makes a failure answerable tomorrow.
      await writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: INVITE_INBOX_ADDRESS,
        entityType: "new_hire_mailbox_adoption",
        newValues: {
          address: INVITE_INBOX_ADDRESS,
          controls: [],
          // `failed` is what separates the two shapes of "no controls". A run that reached the page
          // and found nothing, and a run that never got there, are different diagnoses and must not
          // read alike in the audit a month later.
          failed: true,
          observed: 0,
          reached: false,
          redacted: 0,
          why: clientSafeErrorMessage(error, "The app-passwords page could not be read."),
        },
        summary: `The App Passwords capture of ${INVITE_INBOX_ADDRESS} failed before it could read the page`,
      });
      // Rethrown so the HTTP answer is unchanged: recording a failure must not turn it into a
      // success, and the status still comes from the handler's own catch below.
      throw error;
    }

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: INVITE_INBOX_ADDRESS,
      entityType: "new_hire_mailbox_adoption",
      newValues: {
        address: INVITE_INBOX_ADDRESS,
        // The controls are the whole point of the run, and they are already redacted. Storing them
        // is what makes a capture answerable later without re-opening the mailbox.
        controls: reading.controls,
        // Written on BOTH paths on purpose. If only the failure row carried it, its absence would
        // mean two different things — an older row, or a run that did not throw — and a query for
        // the failures would quietly answer with a mix of the two.
        failed: false,
        observed: reading.observed,
        reached: reading.reached,
        redacted: reading.redacted,
        why: reading.why,
      },
      summary: reading.reached
        ? `Read ${reading.controls.length} control(s) off the App Passwords page of ${INVITE_INBOX_ADDRESS}`
        : `Could not read the App Passwords page of ${INVITE_INBOX_ADDRESS}`,
    });

    return NextResponse.json({ result: { address: INVITE_INBOX_ADDRESS, dryRun: false, ...reading }, success: true });
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
