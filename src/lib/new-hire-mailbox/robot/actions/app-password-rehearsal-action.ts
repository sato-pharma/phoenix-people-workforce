import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

import type { AppPasswordRehearsal } from "../driver";
import { readCompanyInitialPassword } from "../initial-password";
import { INVITE_INBOX_ADDRESS } from "../invite-inbox";
import { createJoinerDriverFromEnv } from "../sweep-deps";
import type { RobotActor } from "./actor";

/**
 * The LIVE body of `POST /api/new-hire-mailboxes/app-password-rehearsal`, after its access checks,
 * its dry-run answer and its rate limit — ONE implementation, run by the website while the robot
 * service is switched off and by `/api/internal/mailbox-robot/app-password-rehearsal` on the robot
 * service once it is on (audit REC-075). It mints ONE app password on the invite inbox and removes it
 * again; the mailbox is the constant and nothing from a request reaches its arguments.
 */
export async function runAppPasswordRehearsalAction(input: { actor: RobotActor }): Promise<NextResponse> {
  const { actor } = input;
  try {
    const companyPassword = String((await readCompanyInitialPassword()) ?? "");
    if (companyPassword.length === 0) {
      return NextResponse.json(
        {
          message:
            "PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD is not set, so there is no password to sign in "
            + "with. Nothing was opened and nothing was minted.",
          success: false,
        },
        { status: 409 },
      );
    }

    const driver = await createJoinerDriverFromEnv();
    let result: AppPasswordRehearsal;
    try {
      try {
        result = await driver.rehearseAppPasswordRemoval({
          address: INVITE_INBOX_ADDRESS,
          password: companyPassword,
        });
      } finally {
        await driver.close().catch(() => {});
      }
    } catch (error) {
      // 🔴 A THROW HERE IS THE WORST CASE TO LOSE, because the run may have minted before it threw
      // and nothing in the response would say so. The row is written with `outstanding: null` —
      // deliberately not `false`, which would be a claim this path cannot support.
      await writeAuditLog({
        actorLoginId: actor.loginId ?? null,
        entityId: INVITE_INBOX_ADDRESS,
        entityType: "new_hire_mailbox_adoption",
        newValues: {
          address: INVITE_INBOX_ADDRESS,
          failed: true,
          minted: null,
          outstanding: null,
          rehearsal: true,
          removed: false,
          why: clientSafeErrorMessage(error, "The app-password rehearsal could not be completed."),
        },
        summary:
          `The app-password rehearsal on ${INVITE_INBOX_ADDRESS} threw — whether it minted first is `
          + "not known from here, so the page needs a human look",
      });
      throw error;
    }

    await writeAuditLog({
      actorLoginId: actor.loginId ?? null,
      entityId: INVITE_INBOX_ADDRESS,
      entityType: "new_hire_mailbox_adoption",
      newValues: {
        address: INVITE_INBOX_ADDRESS,
        // Every stage, because a run that stopped early still carries the calibration it bought.
        after: result.after.controls,
        before: result.before.controls,
        confirming: result.confirming.controls,
        failed: false,
        listed: result.listed.controls,
        minted: result.minted,
        outstanding: result.outstanding,
        rehearsal: true,
        removed: result.removed,
        why: result.why,
      },
      summary: result.outstanding
        ? `🔴 The app-password rehearsal on ${INVITE_INBOX_ADDRESS} LEFT A LIVE APP PASSWORD — remove it by hand`
        : result.removed
          ? `The app-password rehearsal on ${INVITE_INBOX_ADDRESS} minted one and removed it again`
          : `The app-password rehearsal on ${INVITE_INBOX_ADDRESS} minted nothing`,
    });

    return NextResponse.json({ result: { address: INVITE_INBOX_ADDRESS, dryRun: false, ...result }, success: true });
  } catch (error) {
    return NextResponse.json(
      {
        message: clientSafeErrorMessage(error, "The app-password rehearsal could not be completed."),
        success: false,
      },
      { status: 500 },
    );
  }
}
