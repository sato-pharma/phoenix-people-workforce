import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  computeNextRuns,
  detectScheduleCollisions,
  formatNextRunHuman,
  type ScheduleCollision,
} from "@/lib/cron-control/cron-expression";
import { listCronJobs } from "@/lib/cron-control/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_COUNT = 5;
const COLLISION_LOOKAHEAD = 10;

// CEO + Super Admin — pure local computation, no GCP mutation. The mandatory step before
// "Confirm & Save" is enabled on the schedule-edit panel; also independently re-checked
// server-side by the schedule route itself, since this API is directly callable. Still a
// POST, so proxy.ts's blanket same-origin check applies regardless of the "no real mutation"
// framing — assertSameOriginMutation here makes that explicit in the route itself too.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      cronExpression?: unknown;
      timeZone?: unknown;
      excludeJobName?: unknown;
    };
    const cronExpression = typeof body.cronExpression === "string" ? body.cronExpression.trim() : "";
    const timeZone = typeof body.timeZone === "string" ? body.timeZone.trim() : "";
    const excludeJobName = typeof body.excludeJobName === "string" ? body.excludeJobName : null;

    if (!cronExpression || !timeZone) {
      return NextResponse.json({ valid: false, error: "cronExpression and timeZone are required." }, { status: 400 });
    }

    const result = computeNextRuns({ cronExpression, timeZone, count: PREVIEW_COUNT });
    if (!result.valid) {
      return NextResponse.json({ valid: false, error: result.error });
    }

    const collisions = await computeCollisions(cronExpression, timeZone, excludeJobName);

    return NextResponse.json({
      valid: true,
      nextRuns: result.nextRuns,
      humanReadable: formatNextRunHuman(result.nextRuns[0], timeZone),
      collisions,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { valid: false, error: error instanceof Error ? error.message : "Failed to preview schedule." },
      { status: 500 },
    );
  }
}

// Non-blocking: if live job state isn't available (IAM not yet granted), just skip the
// collision warning rather than fail the whole preview — schedule validity is pure-local.
async function computeCollisions(cronExpression: string, timeZone: string, excludeJobName: string | null): Promise<ScheduleCollision[]> {
  const candidate = computeNextRuns({ cronExpression, timeZone, count: COLLISION_LOOKAHEAD });
  if (!candidate.valid) return [];

  const listing = await listCronJobs();
  if (!listing.available) return [];

  const otherJobs = listing.jobs
    .filter((job) => job.jobName !== excludeJobName)
    .map((job) => {
      const runs = computeNextRuns({ cronExpression: job.schedule, timeZone: job.timeZone, count: COLLISION_LOOKAHEAD });
      return { jobName: job.label, runs: runs.valid ? runs.nextRuns : [] };
    });

  return detectScheduleCollisions(candidate.nextRuns, otherJobs);
}
