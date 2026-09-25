---
name: ci-docs-fallback-lint-typecheck-gap
description: "A docs-only PR going green in FOUR SECONDS is CORRECT, not a broken check: ci.yml's `changes` job emits docs_only and every step in validate/lint/typecheck is if-ed out, while the jobs still run and report. ci-docs-fallback.yml is DELETED. The old --admin advice here is now impossible and forbidden."
metadata:
  node_type: memory
  type: project
  modified: 2026-08-26T17:25:00.000Z
---

🔴 **REWRITTEN 2026-08-26 — everything this file used to say is obsolete. The gap is FIXED, and the
old workaround is now both impossible and against the rules.**

**What is true now.** `.github/workflows/ci.yml` has a `changes` job that emits a `docs_only`
output. `validate`, `lint` and `typecheck` each `needs: changes` and **always run and always
report** — they are never `if`-ed out at the job level — but every *step* inside them carries
`if: needs.changes.outputs.docs_only != 'true'`. So a markdown-only PR gets four real, green,
required check runs that correctly did no work. `ci.yml` states this design intent in a comment at
its `validate` job.

**The signature, so it is never misread as a broken or faked check.** Measured on #2422
(AGENTS.md-only, head `e314ee07`):

```
changes: success       7s
lint: success          4s     <- docs_only short-circuit
typecheck: success     4s     <- docs_only short-circuit
validate: success      6s     <- docs_only short-circuit
secret-scan: success  14s     <- REAL gitleaks run, always does the work
full-e2e: skipped      0s
```

`secret-scan` is the tell: it is the one check that genuinely executes on a docs PR (~13–14s), so
if lint/typecheck/validate finish in seconds *and* secret-scan does too, something is wrong. Here
it ran properly. `mergeStateStatus` reached `CLEAN` with no intervention.

**Three things the old version of this file got wrong — do not act on them:**

1. **`ci-docs-fallback.yml` NO LONGER EXISTS.** The separate fallback workflow (PR #680, issue
   #679) was folded into `ci.yml`'s `changes` gate. Do not look for it, do not recreate it, and do
   not "add the missing `lint-typecheck` job" to it.
2. **The required contexts were renamed.** There is no `lint-typecheck` context. The four required
   checks are `validate`, `lint`, `typecheck`, `secret-scan` (see `AGENTS.md` §2).
3. **`gh pr merge --admin` is NOT the way to land a docs PR.** `enforce_admins` is now **`true`**,
   so an admin override does not work at all — and even when it did, a merge to `main` ships to
   production immediately and needs the owner's explicit approval regardless. The old note here
   told a session to reach for `--admin` "each time"; that advice is retired.

**How to apply:** when a docs-only PR reports green almost instantly, verify rather than doubt —
check the per-job durations and confirm `secret-scan` took its normal ~14s. Then treat it as a
genuine pass. If a docs PR ever *does* sit `BLOCKED` with no runs, that is the Actions-outage
signature instead (see `AGENTS.md` §2.1 "CI and PRs"), not this.
