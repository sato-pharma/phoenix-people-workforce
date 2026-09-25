---
name: ci-does-not-run-check-harden
description: "Adding a gate to the `ci` script in package.json does NOT make it run in GitHub CI — ci.yml invokes each check as its own step. (check:harden itself was retired 2026-08-18.)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 78db7cee-29fb-4521-b842-dc76f3d165f6
  modified: 2026-08-18T06:52:13.197Z
---

> **UPDATE 2026-08-18: `check:harden` no longer exists** — it was retired at the
> owner's instruction along with the `.git/hooks/pre-push` gate. See
> [[local-validation-gates-are-gone-ci-is-the-gate]]. **The trap below is
> unchanged and now applies to the surviving `ci` script**, and
> `tests/ci-gate-parity.test.ts` pins it mechanically: every `check:*` in the
> `ci` script must appear in a workflow file. Read `check:harden` as `ci` below.

**`ci.yml`'s `validate` job runs each check as its OWN step. It never invokes
`pnpm run check:harden` or `pnpm run ci`.** Verified 2026-08-01 against
`origin/main`: the job lists `check:routes`, `check:migrations`,
`check:sql-backups`, `check:no-stale-domains`, `pnpm audit`, `test`, `build` as
separate `run:` steps. The `check:harden` and `ci` package.json scripts are
**local convenience aliases only**.

**Consequence:** wiring a new gate into `check:harden` (and/or the `ci` script)
leaves it running on the owner's laptop when he remembers, and never on a PR.
The gate looks wired — the package.json diff is convincing — and is in fact
half-wired. This is the same shape as
[[deduction-rules-are-written-in-comments-implemented-half]]: the rule is
stated, half of it is implemented, and it fails open.

**How to apply:** any new `check:*` gate needs BOTH edits — the package.json
script (so `check:harden` covers it locally) **and** a step in
`.github/workflows/ci.yml`'s `validate` job. Put the CI step in the same
position it occupies in the `check:harden` chain so the two orders match.

Verified working on PR #1604: `validate` step 9,
`Check the deductions write contract (what reaches the wire)` — `success`,
adding ~2s to a 3m15s job.

**Check the same way, don't assume:**
`git grep -n "check:harden\|pnpm run ci" origin/main -- .github/workflows`
returns nothing. Individual steps are found with
`git grep -n "run: pnpm run check:" origin/main -- .github/workflows`.

Related: [[deductions-module-god-mode]] (the `month_key` defect this particular
gate exists to catch).
