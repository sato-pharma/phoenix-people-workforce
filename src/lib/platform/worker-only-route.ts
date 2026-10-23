// The NextResponse half of workerOnlyRouteRefusal (process-role.ts stays import-free for the edge
// bundle). Call it first thing after the cron bearer check in a worker-only route's GET.

import { NextResponse } from "next/server";

import { logWarning } from "@/lib/observability/log";
import { workerOnlyRouteRefusal } from "@/lib/platform/process-role";

export function refuseOnPageServer(job: string): NextResponse | null {
  const refusal = workerOnlyRouteRefusal(job);
  if (!refusal) return null;
  logWarning("Worker-only cron job was called on the page server and refused", {
    labels: { event: "cron_refused_on_page_server", job },
  });
  return NextResponse.json(refusal.body, { status: refusal.status });
}
