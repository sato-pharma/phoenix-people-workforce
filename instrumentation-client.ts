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

Sentry.init({
  dsn,
  beforeBreadcrumb: scrubSentryBreadcrumb,
  beforeSend: scrubSentryErrorEvent,
  beforeSendTransaction: scrubSentryTransactionEvent,
  denyUrls: [/extensions\//i, /^chrome:\/\//i, /^moz-extension:\/\//i],
  enabled: Boolean(dsn),
  environment: resolveSentryEnvironment(process.env.NEXT_PUBLIC_VERCEL_ENV),
  ignoreErrors: sentryIgnoredErrors,
  maxBreadcrumbs: 30,
  normalizeDepth: 3,
  release: resolveSentryRelease(process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA),
  sampleRate: parseSentrySampleRate(process.env.NEXT_PUBLIC_SENTRY_ERROR_SAMPLE_RATE, 1),
  // Session Replay is intentionally disabled: it consumes free-tier quota and would
  // require additional CSP allowances (worker-src/blob). Errors are the priority.
  sendDefaultPii: false,
  tracePropagationTargets: [/^\//],
  tracesSampleRate: parseSentrySampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.02),
});

// Instruments client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
