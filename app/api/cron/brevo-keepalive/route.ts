import { NextResponse } from "next/server";

import { logError } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { brevoKeepaliveKeyEnvs, pingBrevoApiKey } from "@/lib/email/brevo-keepalive";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Resets Brevo's 90-day inactivity expiry on the email FAILOVER key, and doubles as a liveness
 * check on that failover — see src/lib/email/brevo-keepalive.ts for why an unused backup key
 * silently dies.
 *
 * Wrapped in withDeadMansSwitch so this job is itself monitored: if the keepalive stops running
 * (scheduler deleted, route renamed, deploy broken), Healthchecks alerts on the MISSING ping.
 * Without that, a keepalive that quietly stopped would leave exactly the silent expiry it exists
 * to prevent — one layer further back, and even harder to spot.
 *
 * A "failed" ping deliberately THROWS: a revoked or already-expired failover key must surface as
 * a red cron run and a dead-man's-switch failure, not a cheerful 200. A "skipped" ping (no
 * BREVO_API_KEY at all) is a legitimate unconfigured state and stays green.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/brevo-keepalive");
  if (denied) return denied;

  try {
    const result = await withDeadMansSwitch("phoenix-brevo-keepalive", async () => {
      // Every Brevo account in the chain dies the same way, so each configured key is pinged; the
      // first account's outcome stays at the top level, the rest are listed beside it.
      const outcomes = await Promise.all(brevoKeepaliveKeyEnvs.map((keyEnv) => pingBrevoApiKey(keyEnv)));
      const failures = outcomes.flatMap((outcome, index) =>
        outcome.status === "failed" ? [`${brevoKeepaliveKeyEnvs[index]}: ${outcome.reason}`] : [],
      );
      if (failures.length > 0) throw new Error(failures.join(" "));
      const [first, ...others] = outcomes;
      return { ...first, otherAccounts: others.map((outcome, index) => ({ keyEnv: brevoKeepaliveKeyEnvs[index + 1], ...outcome })) };
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Brevo failover keepalive failed — the backup email provider key may be revoked or expired", {
      labels: { event: "cron_failed", job: "brevo-keepalive" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Brevo keepalive failed.");
    return NextResponse.json({ error: "brevo_keepalive_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
