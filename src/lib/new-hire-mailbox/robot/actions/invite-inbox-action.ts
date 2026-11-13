import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { addMonitor } from "@/lib/mailbox-monitor/service";

import { readCompanyInitialPassword } from "../initial-password";
import { INVITE_INBOX_ADDRESS } from "../invite-inbox";
import { runInviteInboxAdoption } from "../invite-inbox-runner";
import { createJoinerDriverFromEnv } from "../sweep-deps";
import type { RobotActor } from "./actor";

/**
 * The body of `POST /api/new-hire-mailboxes/invite-inbox` after its access checks — ONE
 * implementation, run by the website while the robot service is switched off and by
 * `/api/internal/mailbox-robot/invite-inbox` on the robot service once it is on (audit REC-075).
 *
 * The address is the constant, never anything from a request: the same chain pointed at an employee
 * locks them out of their mail. The monitor is attributed to the Super Admin who pressed the button,
 * carried in `actor` exactly as the session gave it before the split.
 */
export async function runInviteInboxAction(input: { actor: RobotActor; dryRun: boolean }): Promise<NextResponse> {
  const { actor, dryRun } = input;
  try {
    const result = await runInviteInboxAdoption({
      address: INVITE_INBOX_ADDRESS,
      deps: {
        companyPassword: () => readCompanyInitialPassword(),
        monitor: (monitorInput) => addMonitor(
          {
            appPassword: monitorInput.appPassword,
            displayLabel: monitorInput.displayLabel,
            emailAddress: monitorInput.emailAddress,
          },
          actor.hrId ?? null,
        ),
      },
      driver: dryRun ? undefined : await createJoinerDriverFromEnv(),
      dryRun,
    });

    // Audited even for a dry run: asking is worth a record of who asked. The result carries no
    // credential — a test asserts that on every path.
    //
    // 🔴 `detail` IS THE ONLY THING HERE THAT SAYS WHY, SO IT IS AUDITED. `refusal` is the gate's
    // enum and is null on every run the gate allowed — so a run that reached Turbify and came back
    // beaten stored `refusal: null`, `adopted: false` and nothing else, and the sentence naming the
    // control that stopped it existed only on the screen of whoever clicked. Measured 2026-10-03:
    // the two live runs that night both read exactly that, and the diagnostic had to be copied out
    // of the browser by hand to be read at all. `handover` is deliberately NOT audited — for a new
    // hire the company password becomes their real password, so that sentence can carry a
    // credential where `detail` never does.
    await writeAuditLog({
      actorLoginId: actor.loginId ?? null,
      entityId: result.address ?? INVITE_INBOX_ADDRESS,
      entityType: "new_hire_mailbox_adoption",
      newValues: {
        address: result.address,
        adopted: result.adopted,
        detail: result.detail,
        dryRun: result.dryRun,
        refusal: result.refusal,
      },
      summary: result.adopted
        ? `Adopted the invite inbox ${result.address}, which Phoenix can now read`
        : (dryRun ? `Planned the invite inbox adoption of ${INVITE_INBOX_ADDRESS}` : `Invite inbox adoption did not finish`),
    });

    return NextResponse.json({ result, success: true });
  } catch (error) {
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The invite inbox adoption could not be run."), success: false },
      { status: 500 },
    );
  }
}
