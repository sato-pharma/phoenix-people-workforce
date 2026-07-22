// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn:
    process.env.SENTRY_DSN ??
    "https://0cb6a7f804dcba65701b98bffa914f27@o4511776154583040.ingest.de.sentry.io/4511777616298064",

  // Without this, local `next dev` and production share one bucket in Sentry — dev-only
  // noise (e.g. transient Fast Refresh/webpack HMR glitches) shows up as "High priority"
  // production issues (confirmed: PHX-B9-4/5/6 were all local dev-server errors).
  // K_SERVICE is Cloud Run's auto-injected service name — "phoenix-hr-staging" for
  // staging, "phoenix-hr" for production (both run the identical built image; NODE_ENV
  // alone can't tell them apart since staging reuses the prod build).
  environment:
    process.env.NODE_ENV !== "production"
      ? "development"
      : process.env.K_SERVICE === "phoenix-hr-staging"
        ? "staging"
        : "production",

  // COMMIT_SHA is set as a runtime env var at deploy time (deploy-cloud-run.yml/
  // deploy-cloud-run-staging.yml); NEXT_PUBLIC_COMMIT_SHA is the build-time fallback.
  // Both carry the same $SHA_TAG value from the same workflow run.
  release: process.env.COMMIT_SHA || process.env.NEXT_PUBLIC_COMMIT_SHA,

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
