# Test coverage — what the number means here

> **Nothing gates on coverage in this repo.** There is no coverage threshold and no PR check that
> reads one. The hosted scanner that used to publish these figures was removed entirely on
> 2026-09-08 at the owner's instruction; `pnpm run coverage` (c8) is now the only thing that
> produces them, on demand and locally.
>
> **The measurements below remain accurate and still worth reading.** They are the real numbers for
> this codebase and the reasoning behind them is unchanged — what is gone is the gate, not the
> arithmetic.

The point of this page is one lesson: **the same test data produced 4.3% and 55% depending on how
absent files were counted.** That gap, not either figure, is the thing worth understanding.

## The short version

| Figure | Value | What it is |
|---|---|---|
| Repo-wide, honest | **22.5%** | 117,862 / 523,394 lines, `c8 --all` |
| Repo-wide, flattered | 55.1% | what you get without `--all` — see below |
| After excluding UI and routes | **44.9%** | 117,431 / 261,795 — of the code that can be unit-tested |
| **Branch coverage** | **73.8%** | the figure that reflects tested decision logic |

## Why 55% was not real

`c8` only reports files it **loaded**. Most of this repo's 605 tests are *source-inspection* tests:
they `readFileSync` a module and assert on its text — "this route must call `assertPermission`",
"this migration must not set `version`". That style is unusually effective here (it is what caught
the direct-orders evidence-gate regression, and what pins the locked pricing rule), but it never
`import`s the module. So the file is absent from `lcov.info` entirely.

**Absent is not zero.** Without `--all`, those files drop out of the *denominator*, which inflates
the average; counting a never-loaded file as 0% is what gives 22.5%. Same data, two answers an order
of magnitude apart, and only one of them is honest.

🔴 **`--all` is why the honest number exists, and it has been lost once already.** It used to live in
the scanner's workflow rather than in the repo, so deleting that workflow on 2026-09-08 would have
silently reverted `pnpm run coverage` to the flattered figure — no error, no warning, just a number
that quietly doubles. It is now baked into the `coverage` script in `package.json`. **Do not remove
it**; a coverage number without `--all` is not a smaller truth, it is a different question.

## Why UI and routes are read separately

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

So the useful question is not "what is the repo's coverage" but *of the logic we can unit-test, how
much do we?* — which is the 44.9% row. Read the two halves apart; averaging them tells you nothing.

## If a threshold is ever wanted again

The number to beat would be today's 44.9%, and the lesson from the last attempt is the important
part: the default **80% blocked a PR outright**. Over Supabase-bound services that is unreachable
without a test-seam programme, and **an unreachable gate is one everybody learns to ignore** — worse
than no gate, because it teaches the team to scroll past a red CI. Set one only slightly above the
real number, if at all.

## Raising the real number

The honest path is test seams for the Supabase-bound services (inject the client rather than
importing `getSupabaseAdmin()`), which lets those modules be executed in tests instead of only
inspected. `tests/stubs/` and `tests/alias-loader.mjs` already do this for the email layer — that is
the pattern to copy. Raise any threshold as the real number climbs, never ahead of it.
