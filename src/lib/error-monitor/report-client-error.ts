"use client";

// Best-effort client-side crash reporter. Sends to our own /api/errors/client
// endpoint (self-hosted, free-forever) in addition to whatever Sentry already
// does. Must never throw — a failed report should never surface as a second,
// user-visible error on top of the one being reported.

export type ReportClientErrorInput = {
  error: unknown;
  route?: string | null;
  digest?: string | null;
  // React error boundaries provide errorInfo.componentStack (which component tree threw).
  // window.onerror/unhandledrejection cannot, so this is optional.
  componentStack?: string | null;
};

export function reportClientError({ error, route, digest, componentStack }: ReportClientErrorInput): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;
    const resolvedRoute = route ?? (typeof window !== "undefined" ? window.location.pathname : null);

    const payload = JSON.stringify({
      componentStack: componentStack ?? null,
      digest: digest ?? null,
      message,
      route: resolvedRoute,
      stack,
    });

    void fetch("/api/errors/client", {
      body: payload,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      method: "POST",
    }).catch(() => {
      // Swallow — reporting is best-effort.
    });
  } catch {
    // Swallow — reporting must never throw.
  }
}
