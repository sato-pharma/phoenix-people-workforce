import { NextResponse } from "next/server";

import { getDeployRevision } from "@/lib/observability/deploy-identity";
import { readUrgentDeployRevision } from "@/lib/observability/urgent-deploy-marker";

// Liveness probe for the platform / uptime checks. Intentionally does NO dependency work
// (no DB, no network) — it only proves the container is up and serving HTTP. Public and
// unauthenticated by design; it exposes no data. Kept cheap so it can be polled often.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// When this server process started, to the second. A Railway variable change redeploys the SAME commit, so
// `revision` cannot say whether a new value is live; a `startedAt` after the change can (18 Nov 2026: a key
// swap could not be confirmed from here). Taken from the process's own uptime, once, so it is the process's
// start and not the first request's.
const STARTED_AT = new Date(Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000).toISOString();

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
      startedAt: STARTED_AT,
      time: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
