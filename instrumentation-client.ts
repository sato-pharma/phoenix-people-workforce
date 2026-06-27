// Sentry initialization for the browser. Next.js 16 loads this automatically.
// The DSN must be public (NEXT_PUBLIC_*) to be available in the browser. A Sentry
// DSN is a publishable identifier, not a secret. Inert until the DSN is set.
import * as Sentry from "@sentry/nextjs";

import {
  parseSentrySampleRate,
  resolveSentryEnvironment,
  resolveSentryRelease,
  scrubSentryBreadcrumb,
  scrubSentryErrorEvent,
  scrubSentryTransactionEvent,
  sentryIgnoredErrors,
} from "@/lib/observability/sentry";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const replayEnabled = Boolean(dsn) && process.env.NEXT_PUBLIC_SENTRY_REPLAY_ENABLED === "true";

Sentry.init({
  dsn,
  beforeBreadcrumb: scrubSentryBreadcrumb,
  beforeSend: scrubSentryErrorEvent,
  beforeSendTransaction: scrubSentryTransactionEvent,
  denyUrls: [/extensions\//i, /^chrome:\/\//i, /^moz-extension:\/\//i],
  enabled: Boolean(dsn),
  environment: resolveSentryEnvironment(process.env.NEXT_PUBLIC_VERCEL_ENV),
  ignoreErrors: sentryIgnoredErrors,
  integrations: replayEnabled
    ? [
        Sentry.replayIntegration({
          blockAllMedia: true,
          maskAllText: true,
        }),
      ]
    : [],
  maxBreadcrumbs: 30,
  normalizeDepth: 3,
  release: resolveSentryRelease(process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA),
  replaysOnErrorSampleRate: replayEnabled
    ? parseSentrySampleRate(process.env.NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE, 1)
    : 0,
  replaysSessionSampleRate: replayEnabled
    ? parseSentrySampleRate(process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE, 0)
    : 0,
  sampleRate: parseSentrySampleRate(process.env.NEXT_PUBLIC_SENTRY_ERROR_SAMPLE_RATE, 1),
  // Session Replay is opt-in per environment. Normal sessions default to 0%;
  // error sessions default to 100% only when Replay is explicitly enabled.
  sendDefaultPii: false,
  tracePropagationTargets: [/^\//],
  tracesSampleRate: parseSentrySampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.02),
});

const isLocalDev =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

const ignoredResourceUrlPatterns = [
  /vercel\.live\/_next-live\/feedback\/feedback\.js/i,
  // Turbopack / webpack dev-server resources that fail when SWC workers crash
  /\/_next\/static\/development\//i,
  /\/__nextjs_original-stack-frames/i,
  /\/_next\/webpack-hmr/i,
];
const reportedResourceFailures = new Set<string>();

function resourceUrlFromTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLImageElement || target instanceof HTMLScriptElement) return target.src;
  if (target instanceof HTMLLinkElement) return target.href;
  if (target instanceof HTMLSourceElement) return target.src;
  return null;
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "error",
    (event) => {
      const resourceUrl = resourceUrlFromTarget(event.target);
      if (!resourceUrl) return;
      if (isLocalDev) return; // Dev-mode resource failures are not actionable
      if (ignoredResourceUrlPatterns.some((pattern) => pattern.test(resourceUrl))) return;

      const tagName = event.target instanceof HTMLElement ? event.target.tagName.toLowerCase() : "unknown";
      const failureKey = `${tagName}:${resourceUrl.split("?")[0]}`;
      if (reportedResourceFailures.has(failureKey)) return;
      reportedResourceFailures.add(failureKey);

      Sentry.captureMessage("Client resource failed to load", {
        extra: { tagName, url: resourceUrl.split("?")[0] },
        level: "warning",
        tags: { area: "client-resource", resourceTag: tagName },
      });
    },
    true,
  );
}

// Instruments client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
