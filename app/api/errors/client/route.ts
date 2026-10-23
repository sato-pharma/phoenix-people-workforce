import { NextResponse } from "next/server";

import { resolveActivityModule } from "@/lib/activity/modules";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  CLIENT_ERROR_MAX_BODY_BYTES,
  CLIENT_ERROR_RATE_LIMIT,
  CLIENT_ERROR_RATE_WINDOW_MS,
  clientErrorBodyTooLarge,
  sanitizeClientErrorReport,
} from "@/lib/error-monitor/client-error-intake";
import { logAppError } from "@/lib/error-monitor/service";
import { getDeployRevisionTag } from "@/lib/observability/deploy-identity";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Best-effort ingestion endpoint for crash reports. Used directly by browsers
// via src/lib/error-monitor/report-client-error.ts (always source: "client"),
// and internally by instrumentation.ts's onRequestError, which forwards
// server-side request errors here with source: "server" — instrumentation.ts
// runs in the Edge Runtime too and can't import Node-only session/crypto code
// directly, so it delegates the HR-ID/module resolution to this route instead.
// Works for guests too (e.g. a crash on the login page), since a bug report must
// never depend on the user already being authenticated.
//
// LIMITED SINCE 23 Oct 2026 (audit P5-03): a body over 64 KB is refused, every stored field is capped
// (client-error-intake.ts), and one address may send CLIENT_ERROR_RATE_LIMIT reports a minute — so an
// anonymous script can no longer fill System Issues and the weekly digest.
export async function POST(request: Request) {
  if (clientErrorBodyTooLarge(request.headers.get("content-length"))) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  }

  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: CLIENT_ERROR_RATE_LIMIT,
      scope: "client_error_report",
      windowMs: CLIENT_ERROR_RATE_WINDOW_MS,
    });
  } catch (error) {
    if (error instanceof ApiRateLimitError) {
      return NextResponse.json(
        { ok: false, error: "rate_limited" },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    // The limiter itself could not be read (the database is down). A crash report must not depend on
    // it, and the insert below meets the same outage and is caught there.
    console.error("Error-report rate limit unavailable:", error);
  }

  try {
    const raw = await request.text();
    // A body with no (or a false) Content-Length is capped on the read as well.
    if (raw.length > CLIENT_ERROR_MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const report = sanitizeClientErrorReport(parsed);

    if (report.message) {
      const access = await resolveAccessContext(request);
      const activityModule = resolveActivityModule(report.route);

      await logAppError({
        clientContext: report.clientContext,
        componentStack: report.componentStack,
        digest: report.digest,
        environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
        hrId: access.hrId,
        loginId: access.loginId,
        message: report.message,
        moduleKey: activityModule.key,
        moduleLabel: activityModule.label,
        release: getDeployRevisionTag(),
        role: access.role,
        route: report.route,
        routeType: report.routeType,
        source: report.source,
        stack: report.stack,
        userAgent: request.headers.get("user-agent"),
      });
    }
  } catch (error) {
    console.error("Failed to ingest error report:", error);
  }

  return NextResponse.json({ ok: true });
}
