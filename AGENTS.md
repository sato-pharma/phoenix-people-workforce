# Phoenix Workforce Engineering Agent Rules

## Scope And Precedence

- These rules apply to every AI agent and automation tool working in this repository.
- Higher-priority platform or system instructions take precedence. The nearest nested `AGENTS.md`, if one exists, may add rules for its directory.
- This file is the repository source of truth. Keep tool-specific files such as `CLAUDE.md` or Copilot instructions thin and point them here instead of copying the full policy.
- When instructions conflict or the requested scope is unclear, stop before the risky action and explain the conflict plainly.

## Communication

- Reply in English unless the user explicitly asks for another language.
- Be direct, practical, and understandable to a non-engineer.
- Explain what is happening, the material risk, and the next decision. Avoid unnecessary theory and repeated approval prompts.
- Prefer executing safe work with available tools over giving the user commands to copy and run.

## Operating Principles

- Act as a senior engineer and production guardian, not only a code generator.
- Use repository evidence and live checks. Do not guess about branches, deployments, schemas, permissions, or production state.
- Make the smallest coherent change that solves the request. Preserve business logic and unrelated user work.
- Automate inspection, implementation, validation, and reporting. Keep release authority with the user.
- Passing tests proves technical readiness; it never grants permission to merge or change production.

## Hard-Learned Rules (each cost a real incident — do not relearn them)

- **Never use `gh pr merge --auto`.** `main` is not branch-protected, so `--auto` merges instantly and silently. Merge only with an explicit plain `gh pr merge` after separate owner approval.
- **Production deploys ship in scheduled windows, not on push.** Merging to `main` deploys staging automatically but NOT production. Verify production after the deploy window runs — never assume a merge is live, and never conclude "deploy is broken" because production lags a merge.
- **Full validation gates must not trust warm TypeScript caches.** `pnpm run check:harden` / CI are authoritative; a bare warm `tsc` can report a false green. For manual full checks use `tsc --incremental false`.
- **Never foreground-watch a long pipeline** (CI run, deploy, big script). Launch it in the background and check at batched checkpoints.
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), not the cookie flow — cookie-based role switching logs the real user out.
- **Merged-branch checks must be squash-aware.** PRs merge by squash, so a merged branch is never an ancestor of `origin/main` — `git branch --merged` is always wrong here. Use `gh pr list --head <branch> --state merged` to test whether work landed.

## Stable Environment Facts

- Production application: `https://phoenix-hr.satopharma.com`
- Staging application: `https://phoenix-hr-staging-897559113412.us-central1.run.app` (Cloud Run
  service `phoenix-hr-staging`, project `phoenix-workforce-498619`, region `us-central1`; deployed
  2026-07-12, points at the staging Supabase project below, isolated from production — no shared
  third-party secrets. Auto-deploys from `main` after CI passes, via
  `.github/workflows/deploy-cloud-run-staging.yml` — same no-traffic/smoke-test/promote gate as
  production, reusing the env vars already configured on the Cloud Run service itself rather than
  any GitHub secret. A manual `gcloud run deploy` (or `workflow_dispatch`) still works if needed.)
- Vercel: fully legacy/decommissioned (old project `phoenix-workforce`) — never deploy to or verify against it.
- Staging Supabase project ref: `cifwmndunmlxjhyjugxa` (`Phoenix-HR-Staging`, Pro org, eu-central-1,
  created 2026-07-11 as a 1:1 clone of production; the prior free-tier staging project,
  ref `izhmxvgiktiafqusolot`, is GONE — as of 2026-07-27 `list_projects` returns only
  `cifwmndunmlxjhyjugxa` and `ozucdzovmcqvepbozvqf`, so that old ref resolves to nothing. Treat any
  doc, script, or prompt still naming it as stale. `scripts/staging-safe-rebuild.ts` is the one
  deliberate exception: its `currentStagingRef` pins the archived ref on purpose and says so.)
- GitHub Actions secret `STAGING_SUPABASE_SERVICE_ROLE_KEY` (added 2026-07-18): the staging
  project's service-role key, used only by `.github/workflows/ci.yml`'s `preview-smoke` job so the
  Playwright login-smoke test (CI_SMOKE_LOGIN_ID account) writes its expected session-rejection
  noise to staging instead of production `audit_logs`. The matching URL/anon key for that same
  step are hardcoded in `ci.yml` (public/non-secret, RLS-protected).
- Production Supabase project ref: `ozucdzovmcqvepbozvqf`

Environment meanings:

- **Local**: this machine or localhost.
- **Preview**: the deployment generated for the current branch.
- **Staging**: a preview connected to the staging Supabase project.
- **Production**: the public production domain and production Supabase project.

Never store passwords, tokens, API keys, service-role keys, JWT secrets, connection strings, or other credentials in this file or in Git. Never assume a pasted preview URL is current; verify live state.

## Session And Worktree Safety

Before editing, run:

```bash
git status
git branch --show-current
git log -1 --oneline
git worktree list
```

- Use one working tree per active session. Parallel sessions must use separate worktrees.
- Start new work from the latest `origin/main` on a focused `codex/<task>` branch unless the user specifies another valid branch.
- Never run `git clone`, `git init`, or any command that recreates the primary repository's `.git` directory.
- Never discard, overwrite, clean, reset, or revert changes you did not create. Treat unexpected changes as user work.
- If the tree is dirty, classify the changes and preserve them. Continue only when the requested work can be isolated safely.
- Create worktrees with `git worktree add`. Remove them only with `git worktree remove` and only after approval.
- Never delete a `.xlsx` or `.pdf` file, even one found as stray/untracked data in a stale or broken worktree folder being cleaned up. Before removing any folder, scan it for `.xlsx`/`.pdf` files first; if any are found and are not already identical to a git-tracked copy, move them into an `xlsx/` folder at the repo root (create it if missing) instead of deleting them or the folder that held them.
- Immediately after creating a worktree, run `pnpm run worktree:sync-env` from inside it. `git worktree add` never copies gitignored files, so a new worktree has no `.env.local` (no `PHOENIX_AUTH_SECRET`, Supabase keys, etc.) until this runs — dev-auth and the dev server fail silently otherwise. This is a local file copy only; it never touches Git or prints secret contents.
- Prefer creating worktrees as siblings of this repo (e.g. `git worktree add ../_wt-<task>`), not nested inside it. If a worktree must live inside the repo, its folder name must start with `_wt-` (or live under `.codex-worktrees/`, or `.claude/worktrees/` which Claude Code's own worktree feature uses) — `tsconfig.json`, `eslint.config.mjs`, and `.gitignore` all exclude those patterns so `typecheck`/`lint` don't redundantly walk full duplicate copies of the codebase. (`.claude/worktrees/` is currently excluded only incidentally, via the broader `.claude` exclude entry — if that entry is ever narrowed, add `.claude/worktrees` back explicitly.) A worktree folder inside the repo that doesn't match one of those patterns will silently make every local `typecheck`/`lint` run several times slower (confirmed: ~12x file count, 70s vs 8s). Do not remove or narrow those exclude patterns without confirming no in-repo worktrees would be missed.
- Treat remote history as the source of truth for merged state, while protecting all unpushed local work.

## Parallel Work Model (owner policy, updated 2026-07-31)

The owner runs many streams concurrently on a 16 GB laptop. The constraint is
**processes, not disk**: pnpm hardlinks `node_modules` from one per-drive store
(a parked worktree costs almost nothing), while each dev server or typecheck
instance eats 1–2.5 GB of RAM. Collisions historically came from two sessions
sharing one folder — never from parallel worktrees.

**Route every new task at creation:**

| Tier | Where | Use for |
| --- | --- | --- |
| **A — Cloud session** (Claude Code on the web) — *the default* | Isolated cloud clone, ends in a PR | Any independent code task that does not need localhost browser verification, local files, or locally-authenticated CLIs. CI + staging auto-deploy validate it. Run these on Sonnet by default. |
| **B — Local worktree** (max **2–3 woken** at once, one session per worktree) | Sibling `_wt-<task>` | Only tasks needing the browser preview, dev-auth role sweeps, or local creds. |
| **C — Main checkout** (exactly **one** interactive session — the control tower) | primary repo folder | Reviews, merge/deploy decisions, DB operations, deployed-env verification, worktree triage. Never feature edits here. |

**RAM guardrails:** one dev server at a time, ever; one typecheck/build at a time
locally (parallel validation belongs to CI). **Park/wake pattern:** a worktree not
being validated needs no `node_modules` — wake = `pnpm install --frozen-lockfile`
(seconds, hardlinked) + `pnpm run worktree:sync-env`; park = stop its processes.
"Woken" (installed + processes running), not "existing", is what the 2–3 limit counts.

**Concurrent-session rules:**

- Never two interactive sessions in one folder — the SessionStart lock warning is a
  hard stop, not advice. (A crashed session's lock self-expires after 2 hours; a
  lock whose PID is not a running process is stale.)
- Only the control-tower session rewrites or reorganizes the shared memory index;
  worktree and cloud sessions may append individual memory files but never
  consolidate or rewrite the index (parallel index rewrites have collided before).
- Cloud sessions cannot see local state: put everything they need in the task
  prompt; everything they produce lands in the PR for tower review.

**Delete-on-merge ritual** (run via `/worktree-triage`): after a worktree's PR
merges — verified with `gh pr list --head <branch> --state merged`, never an
ancestry check (squash merges break it) — confirm no uncommitted/untracked work,
run the xlsx/pdf rescue scan per the rule above, then `git worktree remove` and
`git branch -d`, with owner approval. Stale worktrees must not accumulate — 26
folders was the historical failure mode, and 24 recurred by 2026-07-31 because the
ancestry check silently never passed.

- Locked worktrees under `.claude/worktrees/` belong to other live sessions — never
  remove them.

## Branch And Change Isolation

- `main` is production. Use a branch and PR for normal work.
- A direct commit or push to `main` requires explicit, action-specific approval and should be reserved for a justified emergency.
- Use one branch per coherent delivery and one major delivery per PR.
- Keep related fixes together. Put unrelated, experimental, or materially riskier work on another branch.
- Do not carry commits from a merged or stale branch into a new task. Create a fresh branch from `origin/main`.
- Never merge automatically. Never delete a branch or worktree automatically after merge.

## Execution And Approval Matrix

The following actions are automatic when they are within the user's requested scope:

- Read files, search code, inspect Git state, fetch remote metadata, inspect logs, and review diffs.
- Create a focused branch or worktree.
- Edit requested files, format code, run validation, and apply safe local fixes.
- Stage only task-related files and prepare a commit, push, or PR summary.

One bundled approval may authorize all of these delivery actions together:

- Commit the validated task changes.
- Push the task branch.
- Open or update its PR.

The user's current message counts as approval when it explicitly requests those named actions, for example: "implement, commit, push, and open a PR." Do not ask again for an action already approved unless the scope, risk, target, or validation result materially changes.

Always require a separate explicit approval before:

- Merging a PR or otherwise updating `main`. State that merging may trigger production deployment.
- Applying a migration to staging or production.
- Deploying directly to production or changing production environment variables.
- Changing authentication, authorization, RLS, payroll, employee-lifecycle data, or other high-risk live behavior.
- Rebasing, resetting, deleting a branch or worktree, force-pushing, rewriting history, rolling back, or running destructive Git commands.
- Bulk updating or deleting live data, destructive SQL, or any irreversible operation.

Approval is limited to the explained action, scope, environment, and target. Silence, previous approval for another task, or green validation is not approval. For destructive work, show the target, expected impact, backup or recovery plan, and verification plan before asking.

## Delivery Workflow

Use this sequence for implementation work:

```text
Inspect -> isolate -> implement -> validate -> summarize -> approve delivery
-> commit/push/PR -> verify preview and CI -> approve merge -> verify production
```

1. Confirm branch, worktree, dirty state, and task scope.
2. Inspect existing code, tests, and ownership boundaries.
3. Implement the smallest safe change.
4. Run validation appropriate to the change type.
5. Review the final diff and stage only related files.
6. Summarize validation, risk, and the proposed commit/push/PR actions.
7. After bundled delivery approval, commit, push, and open or update the PR automatically.
8. Verify required CI and the newest relevant Ready preview.
9. Ask separately before merge.
10. For runtime-impacting releases, verify the exact production domain after deployment.

## Validation Matrix

Choose validation by blast radius rather than running every command for every edit.

| Change type | Minimum validation |
| --- | --- |
| Documentation or repository instructions only | Review diff, formatting, links, and secret exposure |
| Narrow TypeScript or JavaScript change | Lint, typecheck, and targeted tests |
| Shared runtime, app/API route, server component, environment, or deployment behavior | Lint, typecheck, tests, and build |
| User interface workflow | Relevant code checks plus browser verification at appropriate desktop and mobile sizes |
| Database migration, view, function, RPC, grant, or policy | Migration checks, SQL review, target confirmation, schema/security review, and staging verification after approval |
| Authentication, RLS, payroll, HR lifecycle, sales, permissions, or executive reporting | Full relevant checks, role-based tests, failure-state checks, and explicit risk review |

- Prefer repository scripts defined in `package.json` over improvised commands.
- Never present a known-broken change as ready. A diagnostic or draft push with failures requires explicit approval and clear labeling.
- Distinguish failures caused by the task from pre-existing failures and report both accurately.
- For unavailable data sources, verify that the UI reports unavailability rather than a misleading zero.

## Git Hygiene

Before committing, review:

```bash
git status
git diff
git diff --cached
```

- Stage only files owned by the task.
- Do not commit `.env*`, `.vercel/`, credentials, local artifacts, screenshots, temporary scripts, unrelated lockfile changes, or unrelated user edits.
- Use clear conventional commit messages such as `fix(module): reason`, `feat(module): capability`, `docs(agents): policy change`, or `test(module): coverage`.
- Do not bypass hooks or required checks unless the user explicitly approves the exact exception after seeing the failure.
- Do not amend, rebase, force-push, reset, or rewrite shared history without explicit approval.

## Preview, CI, And Production Verification

- For runtime changes, inspect the newest deployment for the branch; do not trust an older pasted URL.
- Verify deploys with `gh run list --workflow=deploy-cloud-run.yml --limit 3` (production) / `--workflow=deploy-cloud-run-staging.yml` (staging), and `gcloud run revisions list --service phoenix-hr --region europe-west3` (or `phoenix-hr-staging`, `us-central1`) for what is actually serving traffic.
- A PR is merge-ready only when required CI passes, staging is healthy, changed workflows pass smoke testing, and required staging migrations are verified.
- When a page fails, capture the visible error, browser console, relevant network/API response, deployment logs, and database/RLS evidence before proposing a fix.
- After a runtime-impacting production deployment, verify `https://phoenix-hr.satopharma.com`, smoke-test the changed workflow, and inspect production logs.

## Supabase And Data Safety

- All schema changes must be migration-based, repeatable, reviewable, and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref. Staging is `cifwmndunmlxjhyjugxa`; production is `ozucdzovmcqvepbozvqf`. Resolve the ref with `list_projects` rather than trusting any ref pasted in a prompt or copied from an older doc — this line previously named a long-deleted staging project, so the "verify the ref" step confirmed a dead value and the obvious recovery ("staging must be the other one") pointed at production.
- Both Supabase MCP servers (`supabase-staging` and `supabase-production`) can see BOTH projects. The server name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.
- Use ONLY those two named servers for database access. Any UUID-named Supabase tool (a claude.ai account connector, e.g. `mcp__b345e47e-…`) has an unverifiable identity and is deny-listed in `.claude/settings.json` — never call it, and flag it to the owner if it reappears.
- Applying any migration requires explicit approval. Production requires a separate production-specific approval.
- Before destructive or bulk live-data work, inventory the target, create or verify a backup, show the exact mutation, and define post-change counts or checks.
- Verify RLS, grants, RPC authorization, service-role boundaries, and browser-role exposure whenever permissions or data access change.
- Service-role credentials and privileged operations must remain server-only.

## Role-Based Testing

For permission-sensitive work, test the roles affected by the change, including denial paths. Typical minimums are:

- Sales: Super Admin, CEO, National Sales Manager, Regional Manager, and District Manager.
- Coaching: Super Admin, CEO, SFE Manager, Training Manager, and Medical Rep when employee review is affected.
- HR workflows: Super Admin, CEO, HR Specialist, and Employee when portal behavior is affected.

Do not claim role safety from code inspection alone when practical role testing is available.

## Stop Conditions

Stop before delivery or mutation and explain the blocker when:

- The target branch, worktree, environment, project, or requested scope is uncertain.
- Unrelated changes cannot be isolated safely.
- Validation fails and the proposed action would publish known-broken work.
- A PR is conflicted, required checks are failing, or the preview is not the expected deployment.
- A secret may have been exposed. Do not repeat it; recommend revocation and replacement.
- A destructive action lacks a verified target, backup, recovery path, or explicit approval.

## Coding Standards

- Follow existing architecture, naming, and module boundaries.
- Prefer readable, maintainable code and existing utilities over new abstractions.
- Preserve business rules and authorization boundaries.
- Add comments only where intent is not clear from the code.
- Keep changes reviewable and avoid unrelated refactors.

## Reporting

Keep responses proportional to the task. Do not force a large template onto a small change.

For implementation work, report:

- What changed and why.
- Validation results and any pre-existing failures.
- Risk and staging/production impact.
- Actions completed automatically.
- Actions still requiring approval or unavoidable manual work.

Always state clearly when something was not tested, not deployed, or not verified.
