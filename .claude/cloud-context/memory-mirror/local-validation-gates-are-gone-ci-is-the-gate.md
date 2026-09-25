---
name: local-validation-gates-are-gone-ci-is-the-gate
description: "On 2026-08-18 BOTH local validation gates were removed at the owner's instruction — the check:harden script and the .git/hooks/pre-push hook. Do not reintroduce either."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9bdd6297-a7c0-4136-9263-d285c7524d07
  modified: 2026-08-18T06:52:02.267Z
---

**Two separate local gates were removed on 2026-08-18, in that order. Neither is
coming back.**

1. **`pnpm run check:harden`** — deleted from `package.json`, along with the
   `.claude/hooks/ask-before-validation.mjs` hook, the `harden-check` skill, and
   the "validate ONLY when the owner says so" rule in AGENTS.md §7 and
   CLAUDE.md. 25 files. Shipped in PR #2184, merge commit `d4193cad`.
2. **`.git/hooks/pre-push`** — removed by hand, same day, right after. It ran
   `check:routes`, `check:migrations`, `lint` and `typecheck` on **every push**.

**Why:** CI is the gate and always was. `.github/workflows/ci.yml` re-lists
every step itself, and the four required checks — `validate`, `lint`,
`typecheck`, `secret-scan` — run on the PR head commit and block a red merge.
The local runs only duplicated that, slowly, on a 16 GB laptop usually carrying
several sessions.

**How to apply:**

- Push the branch and let the PR's checks answer. No "quick subset" of lint +
  typecheck first, no `pnpm run ci` as a pre-push ritual. `pnpm run ci` still
  exists and still runs the whole thing — use it **only when the owner names
  it**, or before a migration or production deploy, which CI never sees.
- **`.git/hooks/` is NOT version-controlled**, and there is no `prepare`
  script, no `postinstall` and no husky in this repo — so nothing reinstates
  the pre-push hook, and its removal needed no PR. It also means the removal is
  **machine-local**: another clone that had it installed by hand still has it.
  `core.hooksPath` points every worktree at the main `.git/hooks`, so removing
  it once covered all nine live worktrees.
- The removed hook is preserved at `.git/hooks/pre-push.bak-20260730` (git only
  executes a file named exactly `pre-push`, so the `.bak` is inert). Restoring
  it is a copy away if the owner ever asks.

**The symptom that sent me down the wrong path first:** with the hook still
installed, `git push` looked like it was hanging on the network for minutes. It
was not — it was running lint and typecheck. Wrapping the push in
`timeout 75`/`timeout 90` killed it mid-`lint` every time, which reads exactly
like the known [[git-push-to-origin-hangs-retry-immediately]] trap and is a
different thing. After removal a push completes in **2.0 seconds**.

Related: [[ci-does-not-run-check-harden]] (the parity trap that survives, now
about the `ci` script), [[dont-skip-validation-for-ram-wait-instead]] (written
while a local gate still existed — it is about CI-era waiting now).
