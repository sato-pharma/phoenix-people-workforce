// Browser side of Sentry (sentry.io). PRODUCTION ONLY — see sentry-policy.ts for why the gate is the host.
//
// Fed by `reportClientError` (src/lib/error-monitor/report-client-error.ts), the one place every browser
// failure already passes through: React error boundaries, `window.onerror`, unhandled rejections and the
// callers that catch an error themselves. Hooking there, instead of letting the SDK install its own
// global handlers, is what keeps each error reported ONCE. The SDK's GlobalHandlers integration is
// switched off below for the same reason.
//
// The SDK is imported lazily, so a browser that is not on the production host never downloads it. Since
// 2026-10-16 (owner: "everything that could be on sentry") it also runs sampled traces, a profile inside a
// sampled trace, and a session replay of ONLY a session that hit an error — so a production browser loads it
// once the page has gone idle (startSentryBrowser), not on the first error. Every span is scrubbed in
// sentry-policy.ts, and the replay masks all text, all inputs and all media: Phoenix's screens are payroll.

import { systemDeployment } from "@/config/system-settings";
import { isBrowserNoiseMessage } from "@/lib/error-monitor/browser-noise";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { isRedactedServerRenderError } from "@/lib/error-monitor/redacted-server-render";
import {
  SENTRY_ENVIRONMENT,
  SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE,
  SENTRY_REPLAY_SESSION_SAMPLE_RATE,
  scrubSentryEvent,
  scrubSentrySpan,
  sentryClientStatus,
  sentryProfileSessionSampleRate,
  sentryTracesSampler,
} from "@/lib/observability/sentry-policy";

type SentrySdk = typeof import("@sentry/nextjs");

export type SentryClientReport = {
  error: unknown;
  route?: string | null;
  digest?: string | null;
  componentStack?: string | null;
  context?: string | null;
};

let sdk: Promise<SentrySdk | null> | null = null;

function loadSdk(dsn: string): Promise<SentrySdk | null> {
  sdk ??= import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment: SENTRY_ENVIRONMENT,
        maxBreadcrumbs: 20,
        // Our own reporter feeds every window error and rejection into captureClientErrorInSentry.
        integrations: (defaults) => [
          ...defaults.filter((integration) => integration.name !== "GlobalHandlers"),
          // The Next SDK already adds page-load and navigation tracing when tracing is on; add it only if it did not.
          ...(defaults.some((integration) => integration.name === "BrowserTracing") ? [] : [Sentry.browserTracingIntegration()]),
          // Masks every piece of text, every input and all media: the replay shows layout and clicks, never a figure.
          Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true }),
          Sentry.browserProfilingIntegration(),
        ],
        tracesSampler: (context) => sentryTracesSampler(context),
        // No sentry-trace or baggage header is added to any request, same-origin or not.
        tracePropagationTargets: [],
        replaysSessionSampleRate: SENTRY_REPLAY_SESSION_SAMPLE_RATE,
        replaysOnErrorSampleRate: SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE,
        // Off while the page survey traces every page, exactly as on the server (sentry-policy.ts says why).
        profileSessionSampleRate: sentryProfileSessionSampleRate(),
        profileLifecycle: "trace",
        beforeSend: (event) => scrubSentryEvent(event),
        beforeSendSpan: (span) => scrubSentrySpan(span),
      });
      return Sentry;
    })
    .catch(() => null);
  return sdk;
}

/**
 * Starts the browser SDK once the page is idle, so tracing and the error-time replay buffer run from early in
 * the session without competing with first paint. A no-op anywhere but the production host.
 */
export function startSentryBrowser(): void {
  try {
    if (typeof window === "undefined") return;
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    const productionHost = new URL(systemDeployment.productionUrl).hostname;
    if (!sentryClientStatus({ dsn, hostname: window.location.hostname, productionHost }).enabled) return;
    const start = () => void loadSdk(dsn as string);
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(start, { timeout: 5000 });
    else window.setTimeout(start, 3000);
  } catch {
    // Starting Sentry must never throw into the page.
  }
}

export function captureClientErrorInSentry(report: SentryClientReport): void {
  try {
    if (typeof window === "undefined") return;
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    const productionHost = new URL(systemDeployment.productionUrl).hostname;
    if (!sentryClientStatus({ dsn, hostname: window.location.hostname, productionHost }).enabled) return;
    if (isBrowserNoiseMessage(describeThrown(report.error))) return;
    // A production server-render failure reaches the browser as Next's opaque placeholder with a
    // digest only. The server already reported the real error through onRequestError, so a browser
    // copy is a duplicate with no cause in it (PHOENIX-WORKFORCE-9). The production React client
    // throws it MINIFIED, as "Minified React error #441", so the spelled-out wording alone never
    // matched what a browser actually sends (every #441 row in the error table, 14 days to 26 Oct 2026).
    if (report.digest && isRedactedServerRenderError(describeThrown(report.error))) {
      return;
    }

    void loadSdk(dsn as string).then((Sentry) => {
      if (!Sentry) return;
      try {
        Sentry.withScope((scope) => {
          if (report.route) scope.setTag("route", report.route);
          if (report.digest) scope.setTag("digest", report.digest);
          if (report.componentStack) scope.setExtra("componentStack", report.componentStack);
          if (report.context) scope.setExtra("clientContext", report.context);
          if (report.error instanceof Error) Sentry.captureException(report.error);
          else Sentry.captureMessage(describeThrown(report.error), "error");
        });
      } catch {
        // Reporting must never throw.
      }
    });
  } catch {
    // Reporting must never throw.
  }
}
