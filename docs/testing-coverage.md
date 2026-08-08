# Test coverage — what the number means here

> **The SonarQube PR check was retired on 2026-08-05** (owner decision) —
> `.github/workflows/sonarqube.yml` is trigger-disabled and no longer runs on pull requests. Its
> Quality Gate proved unsatisfiable: the failing condition was `Security Hotspots Reviewed = 100%`,
> which counts human UI reviews rather than code quality, and which re-raises every time
> `update-branch` moves the head. See that workflow's header for the full account.
>
> **The measurements below remain accurate and still worth reading** — the `c8 --all` wiring is
> unchanged, and these are the real numbers for this codebase. What is no longer live is the *gate*:
> the "recommended threshold" note near the end is superseded, since nothing is gating on it.
> `sast-scan` and `secret-scan` were never actually required checks on main, and the workflow that
> ran them (`security-scan.yml`) was removed 2026-08-08.

Written 2026-08-05, after PR #1748 was blocked by SonarQube reporting **4.3% coverage on new code**
while the repo appeared to be at **55%**. Both figures were produced by the same tooling, and the
gap between them is the whole story.

## The short version

| Figure | Value | What it is |
|---|---|---|
| Repo-wide, honest | **22.5%** | 117,862 / 523,394 lines, `c8 --all` |
| Repo-wide, old reporting | 55.1% | flattered — see below |
| **After coverage exclusions** | **44.9%** | 117,431 / 261,795 — the number the gate measures |
| **Branch coverage** | **73.8%** | the figure that reflects tested decision logic |

## Why 55% was not real

`c8` only reports files it **loaded**. Most of this repo's 605 tests are *source-inspection* tests:
they `readFileSync` a module and assert on its text — "this route must call `assertPermission`",
"this migration must not set `version`". That style is unusually effective here (it is what caught
the direct-orders evidence-gate regression, and what pins the locked pricing rule), but it never
`import`s the module. So the file is absent from `lcov.info` entirely.

Absent is not zero. The local summary quietly left those files **out of the denominator**, which
inflated the average; SonarQube reads a missing file as **0%**. Same data, two answers an order of
magnitude apart. `--all` in `.github/workflows/sonarqube.yml` closes that gap — the number dropped
to 22.5% and nothing got worse, because the 55% was never true.

## Why the metric excludes UI and routes

Measured by area:

| Area | Coverage | Lines |
|---|---|---|
| `src/` other `.ts` | 72.7% | 3,006 / 4,132 |
| `src/lib/` domain `.ts` | 44.3% | 114,355 / 257,902 |
| `*.tsx` React UI | **0.0%** | 0 / 192,386 |
| `app/` routes + pages | **0.0%** | 0 / 68,113 |

**260,499 lines — half the codebase — sit at exactly 0.0% because unit-testing them requires a
browser or a running server.** No realistic amount of work moves that, and chasing it would mean
writing tests that mock a browser instead of tests that catch bugs.

They remain **fully analysed** for bugs, vulnerabilities and code smells. Only the coverage metric
drops them (`sonar.coverage.exclusions`), so the number answers a question worth asking: *of the
logic we can unit-test, how much do we?*

## The threshold

**50% on new code.** Above today's 44.9%, so it pulls quality upward; reachable by an ordinary PR,
so it stays credible. Set in the SonarQube Cloud UI — it is not a repo file:

> Project → Administration → Quality Gate → (custom gate) → Coverage on New Code ≥ 50

80% was the default that blocked #1748. Over Supabase-bound services it is unreachable without a
test-seam programme, and **an unreachable gate is one everybody learns to ignore** — which is worse
than no gate, because it teaches the team to scroll past a red CI.

## Raising it later

The honest path to a higher number is test seams for the Supabase-bound services (inject the client
rather than importing `getSupabaseAdmin()`), which lets those modules be executed in tests instead
of only inspected. `tests/stubs/` and `tests/alias-loader.mjs` already do this for the email layer —
that is the pattern to copy. Raise the threshold as the real number climbs, never ahead of it.
