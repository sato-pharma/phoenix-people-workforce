// The NextResponse half of workerOnlyRouteRefusal and robotOnlyRouteRefusal (process-role.ts stays
// import-free for the edge bundle). Call it first thing after the cron bearer check in the route.

import { NextResponse } from "next/server";

import { logWarning } from "@/lib/observability/log";
import { robotOnlyRouteRefusal, workerOnlyRouteRefusal } from "@/lib/platform/process-role";

export function refuseOnPageServer(job: string): NextResponse | null {
  const refusal = workerOnlyRouteRefusal(job);
  if (!refusal) return null;
  logWarning("Worker-only cron job was called on the page server and refused", {
    labels: { event: "cron_refused_on_page_server", job },
  });
  return NextResponse.json(refusal.body, { status: refusal.status });
}

/** A robot-only route's guard: 503 `wrong_process` anywhere but the robot service (audit REC-075). */
export function refuseUnlessRobot(job: string): NextResponse | null {
  const refusal = robotOnlyRouteRefusal(job);
  if (!refusal) return null;
  logWarning("Robot-only route was called off the robot service and refused", {
    labels: { event: "robot_route_refused_off_robot_service", job },
  });
  return NextResponse.json(refusal.body, { status: refusal.status });
}
