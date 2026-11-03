---
name: ci-docs-fallback-lint-typecheck-gap
description: "A docs-only PR has NO fast path since 2026-10-06: it runs the whole suite in `static` and `unit`, takes minutes, and its red is real. A docs PR going green in seconds was correct only while that skip existed. ci-docs-fallback.yml is DELETED. The old --admin advice here is now impossible and forbidden."
metadata:
  node_type: memory
  type: project
  modified: 2026-11-03T11:45:25.954Z
  originSessionId: f80f59a1-ff71-4d51-9c13-53b50580ed82
---

🔴 **REWRITTEN 2026-11-03. The fast path this note used to defend was removed from `ci.yml` on
2026-10-06, so a docs-only PR is an ordinary PR now.**

**What is true now.** Every pull request runs `static` and the two `unit` jobs in full, whatever it
changed, and `checks` reports on them. `validate` holds no tests on any PR, so its short run says
nothing about them. Measured on pull request 39 (8 docs files, 3 Nov 2026): `validate` 40s, `static`
102s, `unit (1)` 132s, `unit (2)` 231s, `checks` 12s.

**How to apply:** treat a docs-only PR's red as real and fix it; many tests read `docs/` and
`.claude/`. Do not read a short `validate` as a skipped suite. Read `unit` and `checks`. If a docs PR
sits `BLOCKED` with no runs, that is the Actions-outage signature (see `AGENTS.md` §2.1 "CI and PRs").

**Still true from the older versions of this note:**

1. **`ci-docs-fallback.yml` NO LONGER EXISTS.** The separate fallback workflow (PR #680, issue
   #679) was folded into `ci.yml`. Do not look for it, do not recreate it, and do not "add the missing
   `lint-typecheck` job" to it.
2. **There is no `lint-typecheck` context.** Read the required checks from the protection API, never
   from this line.
3. **`gh pr merge --admin` is NOT the way to land a docs PR.** `enforce_admins` is **`true`**, so an
   admin override does not work at all. A merge to `main` ships to production and needs the owner's
   explicit approval regardless.

**History, for reading old logs.** From 2026-08-26 until the removal, `ci.yml` had a `changes` job
that emitted `docs_only`, and the steps inside the required jobs were skipped on it, so a markdown-only
PR got green checks that did no work. Measured on #2422 (AGENTS.md-only, head `e314ee07`): `changes` 7s,
`lint` 4s, `typecheck` 4s, `validate` 6s, `secret-scan` 14s. That shortcut was removed after #5182, seven
`.claude/cloud-context/*.md` files, passed both required checks in about ten seconds and then failed on
`main`, withholding three production deploys. `ci.yml`'s header holds the account, and
`tests/ci-gate-parity.test.ts` refuses a return.
