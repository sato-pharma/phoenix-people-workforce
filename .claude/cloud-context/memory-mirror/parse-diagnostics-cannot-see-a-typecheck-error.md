---
name: parse-diagnostics-cannot-see-a-typecheck-error
description: "TypeScript's parseDiagnostics and transpileModule are SYNTAX-ONLY — a file that reports 0 diagnostics can still fail CI typecheck. Only a real Program/tsc run sees TS1355 and every other checker error."
metadata: 
  node_type: memory
  type: project
  originSessionId: 391647f9-8f7a-4e5f-a51e-3371c51627f0
  modified: 2026-08-21T07:51:52.515Z
---

**A file that "parses clean" is not a file that typechecks.** `ts.createSourceFile(...).parseDiagnostics`
and `ts.transpileModule(code, { reportDiagnostics: true })` report **syntactic** errors only. Every
*grammar* and *semantic* diagnostic — assignability, missing members, and the whole TS1xxx grammar
family — is produced by the **checker**, which neither of those ever runs.

Measured 2026-08-21 on `typescript 5.9.3`, the exact line CI rejected:

```ts
const f = (p: number) => (p >= 80 ? "emerald" : "rose") as const;
```

- `transpileModule(..., reportDiagnostics: true)` → **CLEAN**
- `createSourceFile(...).parseDiagnostics` → **0**
- `node node_modules/typescript/lib/tsc.js --noEmit --strict <file>` → **`error TS1355`, exit 2**

`as const` may only be applied to a literal, never to a ternary. CI caught it; two rounds of local
static checking did not, and I had reported those files as verified.

**Why:** on this repo the standing rule is *CI is the gate, don't run a local full validation*
([[local-validation-gates-are-gone-ci-is-the-gate]]), so the temptation is to substitute something
cheap that looks like a typecheck. `parseDiagnostics` is that something, and it is a **false green** —
a different one from the warm-cache false green in [[typecheck-incremental-false-green]].

**How to apply:** never call a file "typechecks clean" on the strength of a parse. If you genuinely
need a local answer before pushing, run the **real compiler on a small isolated file**:

```bash
node node_modules/typescript/lib/tsc.js --noEmit --strict <one-tiny-file>.ts
```

That is milliseconds, needs no project graph, and is safe on a saturated 16 GB machine
([[laptop-m17r2-ram-soldered-16gb-ceiling]]) — unlike `pnpm run typecheck`. Reproduce the failing
form first and confirm it errors, then confirm the fix is clean; a before/after where **both** sides
come back clean means the harness is blind, not that the bug is fixed
([[prove-it-fails-verify-which-assertion-fired]]).

Note this worktree has **no `node_modules`** — `git worktree add` never copies gitignored files, so
`tsc` must be invoked from the primary checkout at
`F:\Phoenix Workforce\phoenix-workforce\node_modules\typescript\lib\tsc.js`.

Related: [[typecheck-incremental-false-green]] · [[prove-it-fails-verify-which-assertion-fired]] ·
[[local-validation-gates-are-gone-ci-is-the-gate]] ·
[[crm-mobile-cards-are-module-wide-and-ci-enforced]]
