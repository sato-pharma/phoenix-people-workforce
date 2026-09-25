---
name: test-seams-for-supabase-backed-code
description: "How to unit-test Supabase-backed code in this repo — which functions ARE behaviourally testable, why you must never stand up a real client in a test, and the established source-shape convention for DB-backed paging loops"
metadata:
  node_type: memory
  type: project
  originSessionId: 9174dff8-a94f-4187-b303-cb8cdbd5e8f3
  modified: 2026-08-01T01:46:21.238Z
---

Worked out the hard way on 2026-08-01 while writing the #1520/#1523 regression tests (PR #1535).
Takes ~30 min to re-derive; none of it is stated in one place in the repo.

## 🔴 Never stand up a real Supabase client in a test

The `test` script runs `--env-file-if-exists=.env.local`, and **`.env.local` points at PRODUCTION**
([[local-env-already-points-at-production]]). Anything that constructs a real client — including
"point it at a local fake HTTP server" tricks — risks falling back to prod credentials, because
`getSupabaseAdmin()` caches its client module-globally and an earlier test in the same process may
already have built one. Do not go down this road; a read-only query against prod from a test run is
not worth the cleverness.

## What IS behaviourally testable

`getSupabaseAdmin()` is called **lazily inside functions**, never at module scope. So a big
domain module imports fine under the test loader with **no env vars at all** — verified for
`src/lib/crm/master.ts`. Consequence: **any pure function inside a Supabase-backed module can be
tested for real, it just has to be exported.** Adding `export` to a module-private pure helper is
the right move, and cheap — PR #1535 exported `buildVacationPeriod` + `VacationDayRow`
(crm/master.ts) and `withIdColumn` (crm/reads.ts) for exactly this, with zero logic change.

Prefer that over a source-shape test whenever the logic is pure arithmetic or string handling.

## What is NOT testable, and the convention for it

A **paging loop** that interleaves `supabase.from(...)` calls with cursor arithmetic can't be
driven without a client. The repo has an established, deliberate convention for these: a
**source-shape test** that asserts on the function body's text. Two existing tests state the
reasoning explicitly and are the models to copy:

- `tests/sos-crosswalk-pagination.test.ts` — "This is a source-shape test on purpose. The failure
  only reproduces against a >1000-row table under a live PostgREST, which no unit test can stand up"
- `tests/sales-master-data-pagination.test.ts` — same, and names the convention

Extract the function body with an `indexOf(declaration)` → first `"\n}\n"` slice and regex it. Make
each assertion map to one specific way the bug returns, so the failure message names the mistake.
⚠️ Do NOT assert that a stale claim string is absent from a file — the corrective comment that
*refutes* the claim usually quotes it, so the assertion fires against the fixed code. Hit that on
first run of `tests/crm-checkin-page-boundary.test.ts`.

## Runner mechanics

```
node --experimental-strip-types --experimental-specifier-resolution=node \
     --experimental-loader ./tests/alias-loader.mjs tests/run-tests.ts
```
Full suite ≈ 41s, ~490 tests. Every test file exports `run<Name>Tests()` and must be **imported AND
called** in `tests/run-tests.ts` — two edits, easy to half-do.

- `tests/alias-loader.mjs` only resolves `@/` → `src/` and a fixed stub map (`tests/stubs/`). It is
  **not** a mocking layer; don't try to add module mocks to it.
- Node 24 has `mock.module`, but it needs `--experimental-test-module-mocks`, which is **not** in
  the `test` script. Don't add it — it changes how CI invokes the suite for every other test.
- For a fast prove-it-fails loop, write a throwaway `tests/_prove.ts` that imports one test function
  and takes its name from `process.argv[2]`. Seconds instead of 41s. Delete it before committing.

## 🔴 Testing a DEPENDENCY BUMP: node_modules lies

Added 2026-08-01. `main` pins `@supabase/supabase-js` **^2.110.8**, but **every worktree in the repo
had 2.105.1 installed** — the primary repo included, because it sits on a stale branch. Running a
probe "in the repo" therefore tests the OLD library and returns a confident, meaningless green.
I hit exactly that and nearly reported it.

**Check the installed version, not package.json**, and for a bump verification install the pinned
version into a scratch directory (`npm i pkg@x.y.z` in a temp dir with `{"type":"module"}`) and run
the probe there. Fast, isolated, and unambiguous.

## 🔴 You CANNOT tell staging from production by looking at data

Learned the hard way 2026-08-01 trying to prove a dev server pointed at staging:

- **Staging is a strict SUBSET of production** (110,793 vs 111,317 `ireports360_visits`), because it
  is a restore. So nothing staging holds is unique to staging — every discriminator you find is
  present in prod too. Only prod-only rows discriminate, and the app may not render raw ids.
- **The app ships no Supabase host to the browser** — 4 MB of client chunks contained neither
  project ref. Grepping served HTML/JS tells you nothing.
- `audit_logs` not growing on staging is **ambiguous**, not proof: the page may simply not audit.
- Writing a marker row into staging is the one unambiguous test, and the permission classifier
  blocks it — correctly. Do not route around that.

**The fix: build the gate INTO the thing you control.** Use a throwaway worktree and add a temporary
route that echoes the resolved Supabase host, so one request settles it. Do not try to infer the
target from four indirect signals — that is how an hour disappears.

⚠️ And do not borrow another session's worktree for a long-running server: one was **deleted out
from under a running dev server** mid-check ([[parallel-session-swarm-hazard]]). Use your own.

Related: [[prove-it-fails-verify-which-assertion-fired]] (the discipline these tests are written
under), [[app-visibility-is-application-scoped-not-rls]] (what the CRM/portal read paths actually
use), [[crm-export-streaming-corruption-incident]] (the parallel lesson: a correctness test is not
a performance test), [[typecheck-incremental-false-green]].
