import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

import { defaultAdoptionDeps } from "../adopt-deps";
import { runMailboxAdoption } from "../adopt-runner";
import { createJoinerDriverFromEnv } from "../sweep-deps";
import type { RobotActor } from "./actor";

/**
 * The body of `POST /api/new-hire-mailboxes/adopt` after its access checks — ONE implementation, run
 * by the website while the robot service is switched off and by the robot service's own route
 * (`/api/internal/mailbox-robot/adopt`) once it is on (audit REC-075). The access checks, the parsing
 * and the rate limit stay in the website's route and run first, in the same order as before.
 *
 * The route's own docblock keeps the account of what adoption is and who may run it. What lives here
 * is the run, the audit row and the answer, unchanged.
 */
export async function runAdoptAction(input: {
  actor: RobotActor;
  dryRun: boolean;
  named: string[];
}): Promise<NextResponse> {
  try {
    const result = await runMailboxAdoption({
      deps: defaultAdoptionDeps(),
      driver: input.dryRun ? undefined : await createJoinerDriverFromEnv(),
      dryRun: input.dryRun,
      named: input.named,
    });

    // Audited even for a dry run: asking which mailboxes WOULD be reset is itself worth a record of
    // who asked.
    //
    // 🔴 THE COUNTS SAY HOW MANY FAILED AND NOTHING SAYS WHY, so each outcome's own `detail` is
    // audited beside them. A row reading `failed: 1` is unactionable a day later: the sentence
    // naming what stopped that one mailbox lived only on the screen of whoever clicked, and had to
    // be copied out of the browser by hand (measured 2026-10-03, on the invite inbox).
    //
    // 🔴 `handover` IS DELIBERATELY LEFT OUT. For a new hire the company password becomes their
    // real password, so the hand-over sentence can carry a credential — `detail` and `status`
    // never do, which is why only those two cross into an audit row.
    await writeAuditLog({
      actorLoginId: input.actor.loginId ?? null,
      entityId: input.named.join(","),
      entityType: "new_hire_mailbox_adoption",
      newValues: {
        adopted: result.adopted,
        dryRun: result.dryRun,
        failed: result.failed,
        lockedOut: result.lockedOut,
        named: input.named,
        outcomes: result.outcomes.map((outcome) => ({
          address: outcome.address,
          detail: outcome.detail ?? null,
          status: outcome.status,
        })),
        refused: result.refused,
      },
      summary: input.dryRun
        ? `Planned adoption of ${input.named.length} mailbox(es)`
        : `Adopted ${result.adopted} of ${input.named.length} mailbox(es)`
          + (result.lockedOut > 0 ? ` — ${result.lockedOut} left locked out` : ""),
    });

    return NextResponse.json({ result, success: true });
  } catch (error) {
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The adoption could not be run."), success: false },
      { status: 500 },
    );
  }
}
