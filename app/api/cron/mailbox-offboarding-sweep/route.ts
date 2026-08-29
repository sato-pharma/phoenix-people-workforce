import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { runMailboxOffboardingSweep } from "@/lib/mailbox-offboarding/sweep";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The daily mailbox-offboarding sweep.
 *
 * Opens a revocation task for any leaver holding a mailbox that the exit workflow missed — that
 * call is deliberately best-effort and swallowed, so this is what notices — and then alerts on the
 * three states that mean a leaver can still read company mail: overdue, forwarding lapsed, and the
 * one that matters most, a mailbox whose password was reset while its app passwords were left
 * alive. Nothing but this sweep will ever surface that third case: it looks finished in the
 * Turbify control panel and there is no API to ask.
 *
 * NOT wired to the dead-man's switch yet, unlike the held-order sweep above it. That is a
 * deliberate omission, not an oversight: a switch needs a Healthchecks check created for it, and
 * creating one is an external change to the owner's monitoring account. Wire it the moment this
 * job has a schedule on cron-job.org — an unwatched nightly cron is exactly the failure this
 * repository has already paid for twice.
 *
 * Deliberately runs on GET. A POST to any /api/** path returns 403 even when the route exists, so
 * a POST-only cron endpoint is indistinguishable from a missing one when it is probed.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/mailbox-offboarding-sweep");
  if (denied) return denied;
  try {
    const result = await runMailboxOffboardingSweep();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Mailbox offboarding sweep failed", {
      labels: { event: "cron_failed", job: "mailbox-offboarding-sweep" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Mailbox offboarding sweep failed.");
    return NextResponse.json({ error: "mailbox_offboarding_sweep_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
