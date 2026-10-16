// Browser side of Sentry (sentry.io). PRODUCTION ONLY — see sentry-policy.ts for why the gate is the host.
//
// Fed by `reportClientError` (src/lib/error-monitor/report-client-error.ts), the one place every browser
// failure already passes through: React error boundaries, `window.onerror`, unhandled rejections and the
// callers that catch an error themselves. Hooking there, instead of letting the SDK install its own
// global handlers, is what keeps each error reported ONCE. The SDK's GlobalHandlers integration is
// switched off below for the same reason.
//
// The SDK is imported lazily, so a browser that is not on the production host never downloads it, and
// the first production error waits on one dynamic import rather than on every page load.

import { systemDeployment } from "@/config/system-settings";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { SENTRY_ENVIRONMENT, scrubSentryEvent, sentryClientStatus } from "@/lib/observability/sentry-policy";

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
        sendDefaultPii: false,
        maxBreadcrumbs: 20,
        // Our own reporter feeds every window error and rejection into captureClientErrorInSentry.
        integrations: (defaults) => defaults.filter((integration) => integration.name !== "GlobalHandlers"),
        beforeSend: (event) => scrubSentryEvent(event),
      });
      return Sentry;
    })
    .catch(() => null);
  return sdk;
}

export function captureClientErrorInSentry(report: SentryClientReport): void {
  try {
    if (typeof window === "undefined") return;
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    const productionHost = new URL(systemDeployment.productionUrl).hostname;
    if (!sentryClientStatus({ dsn, hostname: window.location.hostname, productionHost }).enabled) return;

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
