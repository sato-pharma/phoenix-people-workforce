// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn:
    process.env.SENTRY_DSN ??
    "https://0cb6a7f804dcba65701b98bffa914f27@o4511776154583040.ingest.de.sentry.io/4511777616298064",

  // Do not ship anything from local `next dev`. Tagging dev events as environment:development
  // (below) stopped them being mislabelled, but they still landed in the project and buried
  // real signal: of 20 unresolved issues on 2026-07-26, 19 were dev-only artifacts — webpack
  // UnhandledSchemeError, "Can't resolve 'fs'", HMR "Router action dispatched before
  // initialization", stale-module TypeErrors, a rage click on localhost:3417. None were
  // actionable and none could occur in a built container. Local errors are still visible where
  // you are already looking (terminal + browser console); sending them here only costs quota
  // and dilutes the issue list. Set SENTRY_ENABLE_IN_DEV=true to opt a local session back in
  // when you specifically need to reproduce Sentry-side behaviour.
  enabled:
    process.env.NODE_ENV === "production" || process.env.SENTRY_ENABLE_IN_DEV === "true",

  // Without this, local `next dev` and production share one bucket in Sentry — dev-only
  // noise (e.g. transient Fast Refresh/webpack HMR glitches) shows up as "High priority"
  // production issues (confirmed: PHX-B9-4/5/6 were all local dev-server errors).
  // K_SERVICE is Cloud Run's auto-injected service name — "phoenix-hr-staging" for
  // staging, "phoenix-hr" for production (both run the identical built image; NODE_ENV
  // alone can't tell them apart since staging reuses the prod build).
  //
  // The absent-K_SERVICE case matters as much as the staging one: NODE_ENV is "production"
  // in any *built* artifact, including the one CI's preview-smoke job downloads and boots on
  // a GitHub runner. Because that runner has no K_SERVICE, the previous logic fell through
  // to "production" and filed CI failures as production incidents. PHX-B9-10
  // ("SUPABASE_SERVICE_ROLE_KEY is required" on GET /employee-portals) was exactly this: a
  // CI event — url http://localhost:3000, HeadlessChrome, server_name runnervmvrwv9, an
  // azure kernel and a 40-char release instead of Cloud Run's sha-XXXXXXXX — that read as
  // the only production error in the project. Requiring K_SERVICE to claim
  // production/staging keeps production monitoring trustworthy; anything else running a
  // production build (CI, a local `next start`) is bucketed as "ci".
  environment:
    process.env.NODE_ENV !== "production"
      ? "development"
      : !process.env.K_SERVICE
        ? "ci"
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
