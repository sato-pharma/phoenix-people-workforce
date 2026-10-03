/**
 * Adopting the INVITE INBOX — a Super Admin's own action, and the only caller of
 * `runInviteInboxAdoption`.
 *
 * Why it is a route and not a sweep step: it runs a password RESET, once, on the one mailbox Phoenix
 * reads. A scheduled pass that re-ran it would reset the inbox the robot is mid-way through reading
 * and rotate a credential the monitor had just proved. `tests/new-hire-mailbox-invite-inbox.test.ts`
 * fails if anything scheduled so much as names the runner — the same pin adoption carries.
 *
 * The address is NOT taken from the request. It is compared against `TURBIFY_INVITE_RECIPIENT` by
 * identity inside `evaluateInviteInboxAdoption`, because the same chain pointed at an employee's
 * address locks that person out of their mail with nobody told. The body may therefore ask for a dry
 * run, and nothing else.
 */
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { addMonitor } from "@/lib/mailbox-monitor/service";
import { canReadInitialPassword } from "@/lib/new-hire-mailbox/initial-password-store";
import { readCompanyInitialPassword } from "@/lib/new-hire-mailbox/robot/initial-password";
import { INVITE_INBOX_ADDRESS } from "@/lib/new-hire-mailbox/robot/invite-inbox";
import { runInviteInboxAdoption } from "@/lib/new-hire-mailbox/robot/invite-inbox-runner";
import { createJoinerDriverFromEnv } from "@/lib/new-hire-mailbox/robot/sweep-deps";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError } from "@/lib/security/api-rate-limit";

// Required of every route by `scripts/check-routes.mjs`, and both matter here: the driver is
// puppeteer, so this cannot run on the edge, and a cached response would be a stale verdict about
// whether a live mailbox is monitored.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const blocked = assertSameOriginMutation(request);
  if (blocked) return blocked;

  try {
    const access = await resolveAccessContext(request);
    // Same audience as adoption, and for the same reason: this resets a mailbox password, and
    // `canReadInitialPassword` is the one role test that already means "may hold that password".
    if (!canReadInitialPassword(access.role)) {
      return NextResponse.json(
        {
          message:
            "Only the System Administrator can adopt the invite inbox: it resets that mailbox's "
            + "password and stores the credential Phoenix reads it with.",
          success: false,
        },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { dryRun?: unknown };
    // Only an explicit `false` arms a live run, so a malformed body plans rather than acts.
    const dryRun = body?.dryRun !== false;

    if (!dryRun) {
      await assertApiRateLimit({
        identifier: access.loginId ?? access.hrId ?? "unknown",
        limit: 3,
        scope: "new-hire-mailbox-invite-inbox",
        windowMs: 60 * 60_000,
      });
    }

    const result = await runInviteInboxAdoption({
      address: INVITE_INBOX_ADDRESS,
      deps: {
        companyPassword: () => readCompanyInitialPassword(),
        monitor: (input) => addMonitor(
          { appPassword: input.appPassword, displayLabel: input.displayLabel, emailAddress: input.emailAddress },
          access.hrId ?? null,
        ),
      },
      driver: dryRun ? undefined : await createJoinerDriverFromEnv(),
      dryRun,
    });

    // Audited even for a dry run: asking is worth a record of who asked. The result carries no
    // credential — a test asserts that on every path.
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: result.address ?? INVITE_INBOX_ADDRESS,
      entityType: "new_hire_mailbox_adoption",
      newValues: {
        address: result.address,
        adopted: result.adopted,
        dryRun: result.dryRun,
        refusal: result.refusal,
      },
      summary: result.adopted
        ? `Adopted the invite inbox ${result.address}, which Phoenix can now read`
        : (dryRun ? `Planned the invite inbox adoption of ${INVITE_INBOX_ADDRESS}` : `Invite inbox adoption did not finish`),
    });

    return NextResponse.json({ result, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: "You do not have access to this.", success: false }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json({ message: error.message, success: false }, { status: 429 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The invite inbox adoption could not be run."), success: false },
      { status: 500 },
    );
  }
}
