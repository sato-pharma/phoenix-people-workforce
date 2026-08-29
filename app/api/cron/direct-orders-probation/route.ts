import { NextResponse } from "next/server";

import { systemAccessContext } from "@/lib/auth/permissions";
import { runDirectOrderProbationSweep } from "@/lib/direct-orders/pharmacy-probation";
import { sendDirectOrderPhantomReport } from "@/lib/direct-orders/phantom-report";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The 90-day probation sweep (spec A3 — docs/specs/direct-orders-v2.md).
 *
 * Daily: promote every provisional pharmacy that has earned a footprint (distributor sales or a
 * paid collection), and report the ones whose window closed in silence — by name, with the rep's
 * name — to the owner and the CEO.
 *
 * The report is only SENT when there is something to report. A daily "nothing to report" email
 * trains people to ignore the one that matters.
 *
 * WIRED TO THE DEAD-MAN'S-SWITCH 2026-08-23, after this clock ran dead for nine nights unseen.
 * `CRON_SECRET` was rotated on Railway on 2026-08-14; the GitHub Actions copy that
 * .github/workflows/direct-orders-sweeps.yml sends was never re-aligned, so every nightly run
 * 401'd from 2026-08-14 to 2026-08-22 and nobody was told. The workflow's own comment claims a red
 * run "emails the owner" — nine silent nights say otherwise, and a red run in a log nobody opens is
 * not an alert. Healthchecks alerts on the ping that DIDN'T arrive, so it catches the case the
 * workflow cannot report on: the request never reaching this handler at all.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/direct-orders-probation");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-direct-orders-probation", async () => {
      const sweep = await runDirectOrderProbationSweep(systemAccessContext);
      // Inside the switch on purpose: a sweep that finds phantoms and then fails to report them
      // is not a job that ran. The whole point of the sweep is the report reaching a human.
      if (sweep.flagged.length > 0) {
        await sendDirectOrderPhantomReport(sweep.flagged);
      }
      return sweep;
    });
    return NextResponse.json({
      success: true,
      checked: result.checked,
      promoted: result.promoted.length,
      flagged: result.flagged.length,
    });
  } catch (error) {
    logError("Direct-order probation sweep failed", {
      labels: { event: "cron_failed", job: "direct-orders-probation" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Probation sweep failed.");
    return NextResponse.json({ error: "probation_sweep_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
