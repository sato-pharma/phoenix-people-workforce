import { NextResponse } from "next/server";

import { resolveActivityModule } from "@/lib/activity/modules";
import { resolveAccessContext } from "@/lib/auth/server";
import { logAppError } from "@/lib/error-monitor/service";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClientErrorPayload = {
  message?: unknown;
  stack?: unknown;
  digest?: unknown;
  route?: unknown;
  routeType?: unknown;
  source?: unknown;
  componentStack?: unknown;
};

// Best-effort ingestion endpoint for crash reports. Used directly by browsers
// via src/lib/error-monitor/report-client-error.ts (always source: "client"),
// and internally by instrumentation.ts's onRequestError, which forwards
// server-side request errors here with source: "server" — instrumentation.ts
// runs in the Edge Runtime too and can't import Node-only session/crypto code
// directly, so it delegates the HR-ID/module resolution to this route instead.
// Always responds success; works for guests too (e.g. a crash on the login
// page), since a bug report must never depend on the user already being
// authenticated.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as ClientErrorPayload | null;
    const message = typeof body?.message === "string" ? body.message : null;

    if (message) {
      const access = await resolveAccessContext(request);
      const route = typeof body?.route === "string" ? body.route : null;
      const activityModule = resolveActivityModule(route);

      await logAppError({
        componentStack: typeof body?.componentStack === "string" ? body.componentStack : null,
        digest: typeof body?.digest === "string" ? body.digest : null,
        environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
        hrId: access.hrId,
        loginId: access.loginId,
        message,
        moduleKey: activityModule.key,
        moduleLabel: activityModule.label,
        release: process.env.COMMIT_SHA || process.env.K_REVISION || "unknown",
        role: access.role,
        route,
        routeType: typeof body?.routeType === "string" ? body.routeType : null,
        source: body?.source === "server" ? "server" : "client",
        stack: typeof body?.stack === "string" ? body.stack : null,
        userAgent: request.headers.get("user-agent"),
      });
    }
  } catch (error) {
    console.error("Failed to ingest error report:", error);
  }

  return NextResponse.json({ ok: true });
}
