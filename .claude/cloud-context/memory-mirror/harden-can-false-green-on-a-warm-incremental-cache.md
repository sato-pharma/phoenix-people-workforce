---
name: harden-can-false-green-on-a-warm-incremental-cache
description: "a local typecheck passed twice and then failed on the SAME code once the cache was cold — always confirm with `tsc --noEmit --incremental false` before claiming a branch is green (the gate named here, check:harden, was retired 2026-08-18; the cache trap outlived it)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4a13ab2c-b77b-4e77-a1ed-2dd1db5c413b
  modified: 2026-08-22T22:16:19.036Z
---

2026-08-04, data-integrity branch. `pnpm run check:harden` returned exit 0 on the branch, then
exit 2 after a merge, on a typecheck error that had been there the whole time
(`tests/marketing-roi-export-workbook.test.ts` missing a newly-required field). The code did not
change between the passing and failing runs — the incremental cache did.

**How to apply.** The trap is the warm TypeScript cache, not the gate that happened to expose it.
Any local typecheck you run by hand can false-green — so if you run one at all, run the cold form:

    npx tsc --noEmit --incremental false --pretty false

CI is cold by construction, so a warm local green is exactly the state that ships a red PR.
Extends [[typecheck-incremental-false-green]] with the observation that it survived a *full*
validation gate, not just a bare `tsc` — which is what made it dangerous rather than merely annoying.

**Updated 2026-08-23.** This file said *"treat `check:harden`'s typecheck stage as advisory while
iterating and authoritative only cold."* That instruction is unrunnable: `check:harden` was retired
2026-08-18 at the owner's instruction and no longer exists in `package.json`, and AGENTS.md §7 now
forbids any local full validation — **push the branch and let the PR's required checks answer**
([[local-validation-gates-are-gone-ci-is-the-gate]]). The cache trap itself is unaffected and is
codified in AGENTS.md §2. The filename keeps the retired command's name; read it as *"a local
typecheck can false-green on a warm cache."*

🔴 **Compounding trap, hit in the same session:** the background-task NOTIFICATION reported
"exit code 0" for both failing runs, because it reports the wrapper's code, not the command's
(see [[background-task-notification-exit-code-is-the-wrappers]]). Two independent green signals,
both wrong. The only trustworthy check was `grep "harden-exit" <log>` on the line the wrapper
itself appended.
