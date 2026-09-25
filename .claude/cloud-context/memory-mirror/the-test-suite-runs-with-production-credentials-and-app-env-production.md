---
name: the-test-suite-runs-with-production-credentials-and-app-env-production
description: "pnpm run test loads .env.local (PRODUCTION Supabase) while a test sets APP_ENV=production, so any module that writes on isProductionRuntime() writes to production FROM THE SUITE"
metadata:
  type: project
---

`pnpm run test` is `node --env-file-if-exists=.env.local …`, and `.env.local` points at the
**PRODUCTION** Supabase project (AGENTS.md §3). Separately, `tests/dead-mans-switch.test.ts` sets
`APP_ENV=production` on purpose, to exercise a production-only code path — and
`tests/config-drift.test.ts` sets both `APP_ENV=production` and `NODE_ENV=production` inside its own
body.

So for part of every test run, **`isProductionRuntime()` is true while live production credentials
are loaded.** Any module that writes when that returns true will write to production from the test
suite, on a developer laptop, with no prompt and no audit trail.

This is not hypothetical. Found 2026-08-30 while building `public.job_heartbeats` (the in-house
dead-man's switch, PR #2732): `recordJobHeartbeat` writes on exactly that signal, so a plain
`pnpm run test` would have stamped fabricated **successes** onto real job slugs — making stopped
jobs look alive, which is precisely the failure the register exists to catch, manufactured by the
tool meant to catch it. Proven both ways with no credentials loaded: gate set → 0 write attempts;
gate removed → 1 attempt, which failed only for want of a key.

**Why:** the danger is invisible in review. The write looks correctly gated — `isProductionRuntime()`
reads like "only in production", and nothing in the module hints that the *test suite* satisfies it.

**How to apply:** any new code that writes, sends, or mutates on `isProductionRuntime()` needs a
second, suite-specific gate. The one in place is `process.env.PHOENIX_TEST_SUITE === "1"`, set once
at the top of `tests/run-tests.ts` and read by nothing else — so no other test's save/restore can
leave it wrong. `NODE_ENV === "test"` is kept alongside it but is **not** the load-bearing half:
two existing tests reassign `NODE_ENV` mid-suite and restore it in a `finally`, so relying on it
alone makes the gate depend on their discipline surviving every future refactor. Read both lazily,
per call — `tests/run-tests.ts` sets them after every import has already evaluated. Pinned by
`tests/job-heartbeat-register.test.ts` section 10, which asserts both lines still exist in the
source, so deleting either turns a PR red.

**Running the whole suite locally, safely — move `.env.local` ASIDE first.** That is not a
workaround, it is what CI actually does: the `validate` job runs with no `SUPABASE_SERVICE_ROLE_KEY`
at all, which is why its log is full of `role_permission_overrides load failed` /
`user_module_locks load failed` ERROR lines *while every test around them passes*. Those lines are
CI's normal state, not a fault — reading them as the failure is a live mis-diagnosis trap, because
they sit directly above the real assertion in the log. With the env file moved aside the run touches
no database at all, so the hazard this whole file describes cannot fire.

**When that is worth doing at all** — AGENTS.md §7 still stands, CI is the gate and a local full run
is not a pre-push ritual. The one case that earns it: **`runTest` rethrows, so the suite STOPS at the
first failure**, and a PR whose change touches many static guards then reveals them one CI round-trip
at a time. Measured 2026-09-08 on PR #3492 (WhatsApp templates): three separate reds, each a
different guard, each ~5 minutes of CI, before running it locally this way surfaced the remaining
failure — a React #418 hydration bug visible only during September — plus everything behind it in
one pass. 1386 test files, exit 0. Restore `.env.local` immediately afterwards and verify it points
back at production before doing anything else.

Related: [[a-green-test-run-carries-no-type-signal-at-all]] ·
[[nextjs-node-env-inlined-at-build]] · [[local-run-against-prod-db-silently-skips-every-email]]
