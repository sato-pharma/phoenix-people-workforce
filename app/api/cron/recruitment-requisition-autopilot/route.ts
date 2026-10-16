import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runRequisitionAutopilot } from "@/lib/recruitment/requisition-autopilot";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Keep every empty seat recruiting and every finished requisition closed (owner, 2026-10-16: "I
 * don't want manual work in the recruitment").
 *
 * Hourly. Opens an already-open requisition for each empty seat that has none — owned by the Talent
 * Acquisition seat, no approval, no notice, at most `MAX_OPENINGS_PER_RUN` a run — and fills each
 * requisition whose seat row is filled by a named hire. It never cancels. Parked seats and
 * replacements for somebody still employed are left alone. Two runs at once cannot open two
 * requisitions on one seat row: the partial unique index on `ats_requisitions(vacancy_id)`
 * (migration 20261016103744) refuses the second insert, and that seat reports a failure.
 *
 * `?dryRun=1` reports the plan and writes nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/recruitment-requisition-autopilot");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = dryRun
      ? await runRequisitionAutopilot({ dryRun: true })
      : await withDeadMansSwitch("phoenix-recruitment-requisition-autopilot", () => runRequisitionAutopilot());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Requisition autopilot failed", {
      error,
      labels: { event: "cron_failed", job: "recruitment-requisition-autopilot" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Requisition autopilot failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
