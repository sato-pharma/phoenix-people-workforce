import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runPhoenixCrmIntegritySweep } from "@/lib/phoenix-crm/server/photo-dupes";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Phoenix CRM's nightly integrity sweep — 03:35 Cairo.
 *
 * 🔴 IT SENDS NOTHING AND TELLS NOBODY. No notification, no message, no e-mail, no in-app notice, in
 * either direction: not to a rep, and not to a manager either. It reads photos, writes evidence, and
 * stops. The board is where a human looks, on purpose (owner, 2026-09-25, Golden Rule #1) — a nightly
 * alert about a rep's honesty is a rumour on a schedule, and a rep who hears about a check is a rep
 * who knows what to defeat.
 *
 * Why 03:35 and not with the morning jobs: it downloads every photo it has never seen, so it is the
 * only job in this module that costs real egress and real CPU. At 03:35 the field is asleep, the
 * digest is three hours away, and it shares its minute with nothing else in the account, so a red
 * execution names one job.
 *
 * Safe to fire twice, and safe to stop halfway. A photo is fingerprinted at most once — the path is
 * the identity and the insert ignores a duplicate — and a night that reads only half its backlog
 * simply finds the rest tomorrow, oldest first.
 *
 * It returns a count rather than nothing, because "the sweep ran" and "the sweep found photos to
 * read" are different facts, and only one of them is proved by a 200.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/phoenix-crm-integrity-sweep");
  if (denied) return denied;
  try {
    // `signalStart`: a sweep a deploy cut off mid-run reads "started, never finished" at Healthchecks.
    const result = await withDeadMansSwitch("phoenix-crm-integrity-sweep", () => runPhoenixCrmIntegritySweep(), {
      signalStart: true,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Phoenix CRM integrity sweep failed", {
      error,
      labels: { event: "cron_failed", job: "phoenix-crm-integrity-sweep" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Phoenix CRM integrity sweep failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
