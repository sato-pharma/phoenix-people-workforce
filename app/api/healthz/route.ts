import { NextResponse } from "next/server";

// Liveness probe for Cloud Run / uptime checks. Intentionally does NO dependency work
// (no DB, no network) — it only proves the container is up and serving HTTP. Public and
// unauthenticated by design; it exposes no data. Kept cheap so it can be polled often.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "phoenix-hr",
      // K_REVISION is the Cloud Run-injected active revision name; useful to confirm
      // which revision a probe hit. No secrets.
      revision: process.env.K_REVISION ?? null,
      time: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
