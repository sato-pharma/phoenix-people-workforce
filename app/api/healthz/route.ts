import { NextResponse } from "next/server";

import { getDeployRevision } from "@/lib/observability/deploy-identity";
import { readUrgentDeployRevision } from "@/lib/observability/urgent-deploy-marker";

// Liveness probe for the platform / uptime checks. Intentionally does NO dependency work
// (no DB, no network) — it only proves the container is up and serving HTTP. Public and
// unauthenticated by design; it exposes no data. Kept cheap so it can be polled often.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "phoenix-hr",
      // Which build answered this probe — "is my deploy actually live?" in one request.
      // Resolved across platforms because Cloud Run's K_REVISION does not exist on Railway;
      // this returned null for every request after the 2026-08-01 cutover.
      // An urgent `railway up` deploy carries no git sha; it names itself in public/urgent-deploy.json,
      // which only an urgent upload ever contains, so it wins whenever it is there.
      revision: readUrgentDeployRevision() ?? getDeployRevision(),
      time: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
