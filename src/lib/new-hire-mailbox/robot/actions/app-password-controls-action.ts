import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

import type { AppPasswordPageReading } from "../driver";
import { readCompanyInitialPassword } from "../initial-password";
import { INVITE_INBOX_ADDRESS } from "../invite-inbox";
import { createJoinerDriverFromEnv } from "../sweep-deps";
import type { RobotActor } from "./actor";

/**
 * The LIVE body of `POST /api/new-hire-mailboxes/app-password-controls`, after its access checks, its
 * dry-run answer and its rate limit — ONE implementation, run by the website while the robot service
 * is switched off and by `/api/internal/mailbox-robot/app-password-controls` on the robot service once
 * it is on (audit REC-075). It signs in as the invite inbox with the password Phoenix holds and reads
 * the App Passwords page; it resets nothing, mints nothing and presses no remove control.
 */
export async function runAppPasswordControlsAction(input: { actor: RobotActor }): Promise<NextResponse> {
  const { actor } = input;
  try {
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
        actorLoginId: actor.loginId ?? null,
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
      // success, and the status still comes from the catch below.
      throw error;
    }

    await writeAuditLog({
      actorLoginId: actor.loginId ?? null,
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
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The app-passwords page could not be read."), success: false },
      { status: 500 },
    );
  }
}
