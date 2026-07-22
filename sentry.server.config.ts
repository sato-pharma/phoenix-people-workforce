// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn:
    process.env.SENTRY_DSN ??
    "https://0cb6a7f804dcba65701b98bffa914f27@o4511776154583040.ingest.de.sentry.io/4511777616298064",

  // 100% in dev catches everything locally; 20% in production balances trace coverage
  // against ingest volume/cost. Adjust further with tracesSampler if specific routes
  // need different treatment.
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1 : 0.2,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Deliberately omitting `dataCollection` entirely: passing it at all — even `{}` — flips
  // every unset PII/body-collection category to its permissive default (full user info +
  // HTTP bodies), overriding the SDK's safer `sendDefaultPii: false` default that applies
  // only when this key is absent. This is an HR platform (salaries, personal data) — do not
  // re-add this key without explicit per-field opt-in.
});
