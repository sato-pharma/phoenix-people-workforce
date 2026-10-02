---
name: dont-skip-validation-for-ram-wait-instead
description: "Never substitute manual code review for a real check and call it done — but do not wait out low RAM to run typecheck/lint/build locally either: push the branch and let the PR's CI checks answer (no local quick subset; a local typecheck is denied by bash-guard C8). Need a typecheck before a PR? node scripts/remote-check.mjs typecheck."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 161d958d-7ed4-4088-9964-9f767dbb080f
  modified: 2026-10-02T16:36:36.801Z
---

The RAM-saturation guard ("don't start typechecks/builds while saturated") is a caution to avoid
thrashing the machine, not permission to skip validation entirely. Corrected 2026-08-07: after I
deferred `pnpm run check:edit` on a small logging-severity change because free RAM had dropped to
1.2 GB (offering manual code review as a substitute), the owner said plainly "no typecheck skip."

**Why:** manual review of a diff is not proof it type-checks — [[railway-merge-is-the-production-deploy]]-era
rules exist because "I read it and it looks right" has cost real incidents here. RAM pressure is
usually transient (this session went 4.52 GB → 1.2 GB → 3.64 GB within ~15 minutes of tool calls).

**How to apply:** never skip validation, and never wait out low RAM to run it locally — **push the
branch and let the PR's required checks answer** ([[local-validation-gates-are-gone-ci-is-the-gate]]):
no "quick subset" of lint + typecheck first, no `pnpm run ci` as a pre-push ritual. A local typecheck is
denied outright by `bash-guard.mjs` C8; when you genuinely need one before a PR, run
`node scripts/remote-check.mjs typecheck` (also `lint`, `test`, `build`), which runs on the CI box, not
this laptop. (`check:edit`, named above, is retired.)
**Superseded 2026-10-02:** previously "if RAM is too low, re-check free RAM a few minutes later and run
the check locally" — the 2026-08-18 removal of local gates (CI is the gate) and the 2026-09-25 C8 denial of
local typecheck replaced it.

Only report a check as passing when it was actually run —
capture the real exit code in the SAME shell invocation as the command (`cmd; echo "EXIT=$?"` in one
Bash call), since exit codes do not persist between separate Bash tool calls in this environment.
