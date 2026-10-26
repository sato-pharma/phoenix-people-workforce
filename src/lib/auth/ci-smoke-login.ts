// The CI login smoke test's switch — ONE definition, read by the three places that bend for it.
//
// `ci.yml`'s "Run Playwright login smoke test" step signs in as a hardcoded account with a hardcoded
// password, and three places bend for it: the login route answers that account without touching the
// database, `resolveSessionState` accepts its session without an `app_sessions` row, and the origin
// check trusts a loopback origin on a production build.
//
// WHY BOTH HALVES (audit point 16, owner-approved 2026-10-26). The old gate was
// `APP_ENV !== "production" && PHOENIX_CI_SMOKE_LOGIN === "true"`, written out three times. That is
// fail-OPEN on the one variable it trusts: an environment whose `APP_ENV` is unset or mistyped (it
// went unset once already, 2026-08 — AGENTS.md §2.3) counts as "not production", so one stray
// `PHOENIX_CI_SMOKE_LOGIN=true` would open a published password for a National Sales Manager
// session on a real deployment. Now the environment must say POSITIVELY that it is CI: `APP_ENV`
// must be exactly `ci` (set only by that smoke step), AND the flag must be on. Neither alone does
// anything, and no real deployment ever carries `APP_ENV=ci`.
//
// Both reads are literal `process.env.X` accesses, made at call time: `APP_ENV` is never inlined by
// the bundler (only `NODE_ENV` and `NEXT_PUBLIC_*` are), so a prebuilt production bundle still reads
// the step's environment. Never gate this on `NODE_ENV` — `next build` inlines it to "production".

/** The only account the smoke switch ever signs in (tests/e2e/auth.setup.ts uses the same). */
export const CI_SMOKE_LOGIN_ID = "a-12";

/** True only inside the CI login smoke test: `APP_ENV === "ci"` AND `PHOENIX_CI_SMOKE_LOGIN === "true"`. */
export function isCiSmokeLoginEnabled(): boolean {
  return process.env.APP_ENV === "ci" && process.env.PHOENIX_CI_SMOKE_LOGIN === "true";
}
