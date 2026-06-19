import * as Sentry from "@sentry/nextjs";

import {
  parseSentrySampleRate,
  resolveSentryEnvironment,
  resolveSentryRelease,
  scrubSentryBreadcrumb,
  scrubSentryErrorEvent,
  sentryIgnoredErrors,
} from "@/lib/observability/sentry";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: resolveSentryEnvironment(process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT),
  release: resolveSentryRelease(process.env.NEXT_PUBLIC_SENTRY_RELEASE),
  tracesSampleRate: parseSentrySampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.1),
  sendDefaultPii: false,
  beforeSend: scrubSentryErrorEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
  ignoreErrors: sentryIgnoredErrors,
});
