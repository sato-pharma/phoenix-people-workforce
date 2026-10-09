---
name: as-const-in-a-catch-makes-a-union-new-map-cannot-infer
description: A try/catch inside a .map() callback that returns `as const` tuples from BOTH branches types the catch's `[]` as `readonly []`, so the array is a UNION of two tuple types and `new Map()` fails with TS2769 — invisible to every test.
metadata:
  type: project
---

Adding a `try`/`catch` inside a `.map()` callback so one failed read cannot take the whole
report down turned `new Map(entries)` into a **TS2769 "No overload matches this call"**:

```ts
publishedLines.map(async (line) => {
  try  { return [line, await loadFactAreaMoves(line, period)] as const; }  // readonly [string, Row[]]
  catch { return [line, []] as const; }                                    // readonly [string, readonly []]
})
```

The catch's `as const` types `[]` as **`readonly []`**, which is not assignable to the try's mutable
`Row[]`, so the array is a *union of two tuple types* and `new Map()` can infer neither key nor
value across it. The sibling call site without a `catch` typechecked perfectly, which is what made it
look like the merge with `main` had broken it.

**Why:** PR 5675's `checks` job went red on `src/lib/sales/closing-publication-drift.ts` with ten unit
suites green — see [[a-green-test-run-carries-no-type-signal-at-all]]. Diagnosed from the check-run
**annotations** (`/check-runs/<id>/annotations`), because `gh run view --log-failed` refuses while any
job in the run is still in progress.

**How to apply:** when a `.map()` callback gains a `catch`, drop `as const` from both branches and give
the callback ONE explicit return type — `async (line): Promise<readonly [string, Row[]]> => …` — and
name the row shape (here `FactAreaMove`) rather than repeating it inline. One tuple type, no union.
Confirm with `node scripts/remote-check.mjs typecheck` (~35s); a stage that printed `PASS` really
passed even when ssh then drops and the tool reports NO VERDICT.
