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
import { issueErrorScreenshotTicket } from "@/lib/error-monitor/screenshot-ticket";
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
      // A crash report must not depend on the database being up — but it must not go unlimited while
      // the database is down either (audit, 2026-10-26, point 22). When the bucket store cannot be
      // read, this address is counted in this process instead, in a bounded map.
      onStoreError: "memory",
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
    // With onStoreError "memory" a store outage never reaches here, so this is the limiter failing in
    // a way nothing anticipated. Refused, as the screenshot route beside this one is: an unchecked
    // limit is not a pass.
    console.error("Error-report rate limit failed:", error);
    return NextResponse.json({ ok: false, error: "rate_limit_unavailable" }, { status: 503 });
  }

  // Handed back ONLY when a row was really written, and it names that row and nothing else — never
  // the message, the stack or an environment name (the public answer here stays bare on purpose).
  let screenshotTicket: string | null = null;
  let eventId: string | null = null;

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

      eventId = await logAppError({
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

      // Only a browser gets the offer. instrumentation.ts forwards server-side request errors
      // through this same route, and there is no screen behind one of those to photograph.
      // Signed-in reporters only (owner, 23 Oct 2026). A ticket is the whole authorisation of the
      // picture upload, and this route takes reports from anyone — so a guest ticket let anybody on
      // the internet file a fake report and store a 2 MB image in the Super Admin's error drawer,
      // ten a minute per address, never deleted. A guest's report is still filed; it gets no picture.
      if (eventId && report.source === "client" && (access.hrId || access.loginId)) {
        screenshotTicket = issueErrorScreenshotTicket(eventId);
      }
    }
  } catch (error) {
    console.error("Failed to ingest error report:", error);
  }

  return NextResponse.json(
    screenshotTicket && eventId ? { ok: true, eventId, screenshotTicket } : { ok: true },
  );
}
