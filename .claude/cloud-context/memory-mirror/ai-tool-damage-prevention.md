---
name: ai-tool-damage-prevention
description: "Hard rules every AI session must enforce to prevent Git/test/PR damage — root-caused from 2026-06-14 cleanup session where 15 orphaned worktrees, 3 broken tests, 1 DIRTY PR, and 2 unreleased features were recovered"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 50c9ffda-c81f-455f-814f-8b17108e9f9d
---

On 2026-06-14, a full cleanup session recovered 15 orphaned worktrees, 3 broken test
assertions on `main`, a DIRTY PR (#143), and 2 features that had been sitting in
worktrees for weeks without a PR. The user was not aware of any of this — they depend
entirely on AI tools and cannot detect these issues themselves.

**The AI is the only safety net. These rules must be enforced proactively, without being
asked, in every session.**

> **STATUS (2026-06-15):** The owner deliberately reverted `AGENTS.md` on `main` back to
> its 2026-06-13 state (commit `c6458a36`), which **removed** the Guardian Rule + the 8
> Mandatory Rules sections that commit `b2693d3a` had added to the file on 2026-06-14.
> So these rules **no longer live in `AGENTS.md`** — but the guidance below is still sound
> and worth following. **Do NOT re-add these sections to `AGENTS.md` on `main`** unless the
> owner explicitly asks; that revert was intentional. The June-14 commit stays in git
> history if a restore is ever wanted.

---

## Root Causes

1. **Parallel sessions with no cleanup ritual** → 15 worktrees accumulated silently over weeks
2. **Direct-to-main commits bypassing PR gate** → 3 stale/broken test assertions went undetected
3. **Code changed without updating tests that asserted it** → silent CI breakage
4. **Long-lived branches never rebased** → DIRTY merge conflicts discovered later
5. **Worktree work never cherry-picked into a PR** → CEO exclusion fix sat unreleased for days

---

## Guardian Rule — Never Blindly Execute Risky Orders

When the user gives an order that could cause data loss, break a feature, require
follow-up fixes, risk unreleased work, or damage Git/production state — the AI must
STOP before executing and do the following three things:

**1. State the risk** — plain English, specific about what would break or be lost.
**2. Give a recommendation** — always have a safer alternative ready.
**3. Show both paths side by side:**
   - "If you proceed with your order: [specific consequence]"
   - "If we follow my recommendation: [same goal, done safely]"

Then wait for explicit user approval before acting.

Examples of when this activates:
- "Delete that branch" → but it has unpushed commits
- "Push directly to main" → but tests are failing
- "Just overwrite it" → would lose an existing feature
- "Skip the tests" → risks silent production breakage
- "Merge it now" → PR is in DIRTY state (merge conflict)
- "Reset the data" → no backup exists or records are active
- "Commit everything" → unrelated or sensitive files are staged

Key principle: the goal is never to block the user — it is to make sure they decide
with full information. If the user says "do it anyway" after hearing the consequences,
execute it and note the risk.

**Why:** The user is not a technical expert and relies entirely on AI tools. A "yes-man"
AI causes invisible damage that takes hours to recover. An AI that pushes back with
clear reasoning protects the project without removing the user's authority.

---

## Hard Rules (apply to every session)

**Rule 1 — No direct-to-main code commits.**
All code changes require a branch + PR. Even single-line fixes. Only exceptions:
documentation-only files (AGENTS.md, CLAUDE.md) and explicit user approval.
Before any commit: confirm `git branch --show-current` is NOT `main`.

**Rule 2 — CI is the gate. Do NOT run a local full validation.**
**This rule said "run `npm run check:harden` before every commit" until 2026-08-23. It is now wrong twice over:**
the gate was retired 2026-08-18 at the owner's instruction, and `check:harden` no longer exists in `package.json`.
Push the branch and let the PR answer — `validate` and `checks` are the required checks and
block the merge. *(Corrected 2026-10-01 — the gate is TWO, `validate` and `checks`; read the protection API, never this line.)* Do NOT reintroduce it, and do NOT invent a replacement "quick subset" of lint+typecheck before
pushing. AGENTS.md §7 is the standing rule; see [[local-validation-gates-are-gone-ci-is-the-gate]]. Migrations and
production deploys are the two things CI never sees — those still get a check immediately before the action.

**Rule 3 — Update tests in same PR as code.**
Whenever a commit changes a URL, route, function name, env var, or config string,
run `grep -r "old_value" tests/` and update any matching test assertions in the same PR.

**Rule 4 — New API routes need canAccess.**
Every `app/api/**/route.ts` using `resolveAccessContext` must also call `canAccess()`
or `assertPermission()`. The `access-registry-coverage` test enforces this — run tests
before committing any new route.

**Rule 5 — Rebase branches older than 3 days.**
Before adding work to an existing branch, check how far behind main it is.
If >3 commits behind: rebase before continuing.

**Rule 6 — Session-end cleanup is mandatory.**
After every PR merge: remove its worktree (`git worktree remove <path>`), delete its
local branch (`git branch -d <name>`), confirm clean with `git worktree list`.

**Rule 7 — Max 3 worktrees; session-start health check.**
At the START of every session:
```
git worktree list
git branch
```
If >3 worktrees or >20 local branches: stop and offer cleanup before starting new work.

**Rule 8 — Push every branch to origin before session ends.**
Any branch with uncommitted/unpushed work must be pushed to `origin` at session close.
Work that only exists locally is at risk if the machine has a problem.

---

## Why: User Dependency

The user is NOT comfortable with Git, GitHub, branches, PRs, or terminal workflows.
They rely entirely on AI tools for these operations. They cannot independently:
- Detect stale test assertions
- Spot orphaned worktrees
- Identify DIRTY PRs
- Find unreleased code stuck in local branches

The AI must self-enforce these rules without being asked.

**Why:** On 2026-06-14 the user asked "what did I do wrong?" — the answer was that
multiple AI sessions across weeks each did small things without following lifecycle rules.
The damage accumulated invisibly. The user had no way to know.

**How to apply:** At the start of every session, run the health checks. After every PR,
run the cleanup. Never commit directly to main. Always run the full test gate.

See also: [[parallel-session-swarm-hazard]], [[vercel-preview-env-and-branching]]
