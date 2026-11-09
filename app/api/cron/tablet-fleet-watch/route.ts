import { NextResponse } from "next/server";

import { HeadwindNotConfiguredError, isHeadwindConfigured } from "@/lib/devices/headwind/auth";
import { HeadwindRequestError } from "@/lib/devices/headwind/client";
import { getHeadwindFleet } from "@/lib/devices/headwind/fleet";
import { assessTabletFleet, type FleetWatchRead } from "@/lib/devices/headwind/fleet-watch";
import { notifyTabletFleet } from "@/lib/devices/headwind/fleet-watch-alert";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { readJobHeartbeats } from "@/lib/observability/job-heartbeat";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JOB_SLUG = "phoenix-tablet-fleet-watch";

async function readFleet(): Promise<FleetWatchRead> {
  if (!isHeadwindConfigured()) return { kind: "not_configured" };
  try {
    const fleet = await getHeadwindFleet();
    return {
      awaitingHardwareReport: fleet.awaitingHardwareReport,
      kind: "answered",
      pendingRegistration: fleet.pendingRegistration,
      registerError: fleet.registerError,
      rows: fleet.rows,
    };
  } catch (error) {
    if (error instanceof HeadwindNotConfiguredError) return { kind: "not_configured" };
    // An answer that says no is a settings or password problem and waits for nobody; anything else may pass.
    if (error instanceof HeadwindRequestError && error.status >= 400 && error.status < 500) {
      return { kind: "refused", message: `status ${error.status}` };
    }
    return { kind: "transient", message: describeThrown(error) };
  }
}

/**
 * Hourly: has a tablet held by a rep gone quiet (owner, 2026-11-03). The verdict and the reasons for it are
 * in src/lib/devices/headwind/fleet-watch.ts. It reads the server's device list and nothing else, so no
 * tablet can tell it ran.
 *
 * The switch is pinged directly, never through withDeadMansSwitch, which would report success on a run that
 * returned having seen nothing. `?dryRun=1` reads and reports, with no alert and no ping.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/tablet-fleet-watch");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const previous = (await readJobHeartbeats()).find((row) => row.slug === JOB_SLUG) ?? null;
    const verdict = assessTabletFleet({
      firstSeenAt: previous?.firstSeenAt ?? null,
      nowMs: Date.now(),
      previousDetail: previous?.lastDetail ?? null,
      read: await readFleet(),
    });
    if (dryRun) return NextResponse.json({ dryRun: true, success: true, ...verdict });

    const alert = await notifyTabletFleet(verdict);
    // A tablet nobody was told about is not a clean run of this job.
    const alertLost = alert.skipped && alert.reason !== "healthy";
    await pingDeadMansSwitch(
      JOB_SLUG,
      verdict.outcome === "fail" || alertLost ? "fail" : "success",
      alertLost ? `The tablet alert did not go out (${alert.reason}). ${verdict.detail}` : verdict.detail,
    );
    return NextResponse.json({ alert, success: true, ...verdict });
  } catch (error) {
    logError("Tablet fleet watch failed", {
      error,
      labels: { event: "cron_failed", job: "tablet-fleet-watch" },
    });
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    return NextResponse.json({ error: "watch_failed", success: false }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
