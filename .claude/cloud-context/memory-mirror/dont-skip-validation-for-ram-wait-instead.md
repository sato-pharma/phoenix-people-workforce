---
name: dont-skip-validation-for-ram-wait-instead
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: Push the branch and let the PR's checks answer. No 'quick subset' of lint + typecheck first (see `local-validation-gates-are-gone-ci-is-the-gate`). Older text follows: When RAM is saturated, wait and re-check before running typecheck/lint/build — don't substitute manual code review and call it done"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 161d958d-7ed4-4088-9964-9f767dbb080f
  modified: 2026-08-06T23:22:19.996Z
---

The RAM-saturation guard ("don't start typechecks/builds while saturated") is a caution to avoid
thrashing the machine, not permission to skip validation entirely. Corrected 2026-08-07: after I
deferred `pnpm run check:edit` on a small logging-severity change because free RAM had dropped to
1.2 GB (offering manual code review as a substitute), the owner said plainly "no typecheck skip."

**Why:** manual review of a diff is not proof it type-checks — [[railway-merge-is-the-production-deploy]]-era
rules exist because "I read it and it looks right" has cost real incidents here. RAM pressure is
usually transient (this session went 4.52 GB → 1.2 GB → 3.64 GB within ~15 minutes of tool calls).

**How to apply:** if RAM is too low to validate safely, re-check free RAM a few minutes later
instead of skipping the check outright. Only report a check as passing when it was actually run —
capture the real exit code in the SAME shell invocation as the command (`cmd; echo "EXIT=$?"` in one
Bash call), since exit codes do not persist between separate Bash tool calls in this environment.
