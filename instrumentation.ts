// Next.js instrumentation hook. Forwards server-side request errors (App Router)
// to our own self-hosted app_error_events table (see src/lib/error-monitor/service.ts)
// so crashes stay queryable by HR ID/module.

export async function register() {
  // Edge and Node configs can go here if needed in the future
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

export async function onRequestError(
  error: unknown,
  request: { headers?: Record<string, string | string[] | undefined>; path?: string },
  context: { routeType?: string },
) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && IGNORED_CONNECTION_ERROR_CODES.has(code)) return;
  await forwardServerErrorToIngestion(error, request, context);
}
