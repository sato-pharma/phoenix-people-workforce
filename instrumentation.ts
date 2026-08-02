// Next.js instrumentation hook. Forwards server-side request errors (App Router)
// to our own self-hosted app_error_events table (see src/lib/error-monitor/service.ts),
// so crashes stay queryable by HR ID/module.

import type { Instrumentation } from "next";

// Starts the continuous iReports360 live poller (src/lib/crm/live-poller.ts) exactly once per
// server process. The import MUST stay dynamic and inside the nodejs-runtime guard: this hook is
// bundled for BOTH runtimes (see the edge-safety note below), and the poller pulls in the whole
// CRM/Supabase server stack. The poller's own guards (PHOENIX_LIVE_CRM_POLL flag, production
// build, Railway production env) make this a no-op everywhere except the live Railway service —
// and a startup failure must never break boot, hence the catch.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { startLiveCrmPoller } = await import("@/lib/crm/live-poller");
      const result = startLiveCrmPoller();
      if (!result.started) console.log(`[crm:live-poll] not started: ${result.reason}`);
    } catch (error) {
      console.error("[crm:live-poll] failed to start:", error);
    }
  }
}

// Deliberately avoids importing any server-only module (session/crypto code
// lives behind resolveAccessContext, which needs Node's crypto — unavailable
// in the Edge Runtime). This hook runs in BOTH runtimes, and Turbopack bundles
// it for both regardless of runtime checks, so a direct import here would
// break the edge build. Forwarding to our own /api/errors/client endpoint
// (which does the HR-ID/module resolution safely inside its own nodejs-only
// route) keeps instrumentation.ts itself edge-safe with only `fetch`.
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function forwardServerErrorToIngestion(
  error: unknown,
  request: { headers?: Record<string, string | string[] | undefined>; path?: string },
  context: { routeType?: string },
) {
  try {
    const host = firstHeaderValue(request.headers?.host) || firstHeaderValue(request.headers?.["x-forwarded-host"]);
    if (!host) return;

    const protocol =
      firstHeaderValue(request.headers?.["x-forwarded-proto"]) || (host.startsWith("localhost") ? "http" : "https");
    const cookie = firstHeaderValue(request.headers?.cookie);
    const origin = `${protocol}://${host}`;

    // The app-wide CSRF guard (src/lib/security/csrf.ts) rejects any mutation
    // request that lacks an Origin/Referer matching the request's own host —
    // this server-to-server call needs an explicit Origin for the same reason
    // a browser's same-origin fetch would carry one automatically.
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
    if (cookie) headers.cookie = cookie;

    await fetch(`${origin}/api/errors/client`, {
      body: JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        route: request.path || null,
        routeType: context?.routeType ?? null,
        source: "server",
        stack: error instanceof Error ? (error.stack ?? null) : null,
      }),
      headers,
      method: "POST",
    });
  } catch (loggingError) {
    // Never let our own logging break request-error reporting.
    console.error("Failed to forward server request error to app_error_events:", loggingError);
  }
}

// Captures errors thrown in nested React Server Components / route handlers —
// forwards to our own error table.
// Benign client-initiated disconnect codes — the server is not at fault.
// Forwarding these as errors creates false-positive alerts in the error table.
const IGNORED_CONNECTION_ERROR_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE"]);

export async function onRequestError(...args: Parameters<Instrumentation.onRequestError>) {
  const [error, request, context] = args;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && IGNORED_CONNECTION_ERROR_CODES.has(code)) return;
  await forwardServerErrorToIngestion(error, request, context);
}
