---
name: a-green-test-run-carries-no-type-signal-at-all
description: "`pnpm run test` uses node --experimental-strip-types, which DELETES types without checking them — a whole suite can go green against code that fails typecheck."
metadata: 
  node_type: memory
  type: reference
  originSessionId: faedc714-ba73-4daa-a9e9-810ee2b0f383
  modified: 2026-08-23T21:18:03.862Z
---

`pnpm run test` is
`node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs tests/run-tests.ts`.

**`--experimental-strip-types` ERASES type annotations and runs the JavaScript underneath. It never
checks them.** So a green suite says nothing whatsoever about whether the code typechecks — not
"probably fine", not "mostly checked". Zero signal.

Seen 2026-08-24 on PR #2360: a union widened from `"manager" | "owner"` to
`"area" | "manager" | "owner"` in one place but not in the `Map` holding it. Every test passed
locally; CI `typecheck` went red on the exact assignment. This is distinct from the warm-cache trap
in `AGENTS.md` §2 (a bare local `tsc` reporting a false green) — there the checker ran and was
stale; here **no checker ran at all**.

**How to apply:** never read a passing test run as "it compiles". The `typecheck` job on the PR is
the only thing that answers that question, and it is a required check, so pushing and reading it is
the intended route — do not bolt a local `tsc` onto a 16 GB laptop as a pre-push ritual
(`AGENTS.md` §7 forbids exactly that). Budget for one red-typecheck round trip when a change moves a
type, and when CI does go red, read the failing job rather than re-running the suite. Related:
[[the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open]].
