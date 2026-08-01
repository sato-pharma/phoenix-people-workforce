# Phoenix Workforce — Agent Rules

Operating rules for every AI agent and automation tool in this repository. Codebase reference
(layout, auth, API conventions, cron, env) lives in [docs/architecture.md](docs/architecture.md);
daily commands and the protected-file gate live in [CLAUDE.md](CLAUDE.md). Higher-priority platform
or system instructions take precedence. When instructions conflict or scope is unclear, stop before
the risky action and explain the conflict plainly.

## 0. How this repo is actually run (calibrate to this)

One owner runs everything. He is **not a career engineer** — he is the business owner of a live HR
platform that a real pharmaceutical company runs payroll, attendance, and sales on. Real employees
are paid from this data. Measured over the last 90 days:

- **~30 commits/day, 4.7 files per commit.** Small, focused changes, shipped constantly.
- **1,244 fix commits vs 903 feature commits.** More than half of all work is repairing work.
- **Shipping is the main activity** — a fifth of all instructions are merge/deploy/verify-prod.
- **Sessions run for hours or days** (median 6.5h, some over a week) and are often worked
  **after midnight**. Assume tiredness, assume context has been compacted, assume the human cannot
  hold the whole system in his head at 4am. That is your job, not his.
- **No permission prompt gates anything** (see rule 1.5). You are the last line of defense.

He writes short, terse instructions and expects you to work out the scope. Reply in English always,
whatever language he writes in. Explain like a smart non-engineer: what happened, what it costs,
what to do next. Never hand back a list of manual steps you could have executed yourself.

## 1. The five rules that prevent the rework

These exist because 1.4 fixes per feature is what happens without them.

1. **Show the proof, never the claim.** "Tests pass", "it is deployed", "the migration applied" are
   worthless without the output that shows it. Paste the count, the revision id, the row, the HTTP
   status. If you did not run it, say you did not run it. **Being wrong is recoverable; being
   confidently wrong is what costs a day.**
2. **Verify against live reality, not against a plan or a memory.** A ledger is not the database
   (`list_migrations` lies — query `pg_class`/`pg_proc`). A merged PR is not a deploy. A green CI is
   not a working page. A memory file is a point-in-time note, not current state. Re-check before
   asserting.
3. **Finish every phase.** When given a numbered or phased plan, execute all of it, in order. Never
   stop after 1–2 phases and never silently skip one. If a phase is genuinely blocked, stop and say
   exactly which one and why — do not quietly deliver a subset and call it done.
4. **After compaction or a long session, distrust yourself.** Sessions here routinely run for days,
   so a replayed summary of earlier work can read like a live instruction. Before acting on
   "previous" state, re-run the check. Prefer one fresh session per task over one endless session.
5. **The absence of a permission prompt is not approval.** `permissions.defaultMode` is
   `bypassPermissions` (user-level, set 2026-08-01 after the risk was disclosed twice). Production
   SQL, migrations, `git push`, `gh pr merge`, and the three protected files no longer raise a
   dialog. The repo's `permissions.ask`/`deny` lists still exist but are outranked. **Every approval
   rule in section 6 is therefore behavioral: ask in plain words and wait for a plain answer.**

## 2. Hard-Learned Rules (each cost a real incident — do not relearn them)

- **Never use `gh pr merge --auto`.** `main` IS branch-protected (`enforce_admins: true`, force-pushes and deletions blocked) — but it has **zero required status checks**, so CI never gates a merge and `--auto` would land the PR the moment it is set, green or not. The repo also sets `allow_auto_merge: false`, so the flag is rejected outright. Merge only with an explicit plain `gh pr merge` after separate owner approval. (Verified 2026-08-01.)
- **A merge to `main` SHIPS TO PRODUCTION IMMEDIATELY.** This reversed on 2026-08-01 and is the single most important thing to relearn. Railway is GitHub-connected and deploys on push, at full traffic, with no cron wait, no staged rollout, no smoke test, and — because branch protection requires **zero** status checks — no requirement that CI was ever green. The old Cloud Run pipeline did all four of those things and is gone; `deploy-cloud-run.yml` and `deploy-cloud-run-staging.yml` are trigger-disabled, so a `deploy: skipped` there is now expected rather than informative. **Never merge anything to `main` you are not willing to have serving employees within minutes.** To confirm what is actually live, request `/api/healthz` and read `revision` — not the workflow list. (Until section 3's Phase 2 fix ships, that field may still read `null`.)
- **There is no staging application.** It died with Cloud Run; only the staging *database* survives. Any rule elsewhere in this file requiring staging verification currently has nothing to run against — say so plainly rather than pretending the gate exists.
- **Full validation gates must not trust warm TypeScript caches.** `pnpm run check:harden` / CI are authoritative; a bare warm `tsc` can report a false green. For manual full checks use `tsc --incremental false`.
- **Never foreground-watch a long pipeline** (CI run, deploy, big script). Launch it in the background and check at batched checkpoints.
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), not the cookie flow — cookie-based role switching logs the real user out.
- **Merged-branch checks must be squash-aware.** PRs merge by squash, so a merged branch is never an ancestor of `origin/main` — `git branch --merged` is always wrong here. Use `gh pr list --head <branch> --state merged`.
- **A regression test only counts if you break the fix and confirm the new test's own headline assertion fires.** "The suite went red" is not proof — twice it was an unrelated old test or an adjacent assert.
- **`list_migrations` reports the migration ledger, not reality.** To prove an object exists, query `pg_class`/`pg_proc`.
- **Auto-git workflows are permanently banned.** Auto-executing commit/push/PR/merge was tried and reverted **twice**. Always ask first.

## 3. Stable Environment Facts

- Production application: `https://phoenix-hr.satopharma.com` — **served by Railway since 2026-08-01, no longer Cloud Run.** Railway project `creative-serenity`, service `phoenix-people-workforce`, region `sfo`, deployed from this repo on push (GitHub-connected, so a merge to the default branch ships automatically — there is no deploy workflow and no cron wait any more). Public URL also reachable at `https://phoenix-people-workforce-production.up.railway.app`. Cloudflare holds `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied; the pre-cutover value was `A 8.232.10.208` (Cloud Run) if a rollback is ever needed.
- **GCP is DEAD, not standby.** Billing account `01BDEA-A20B4C-CC568F` closed 2026-08-01 ~21:00 Cairo over an unpaid balance the owner has decided not to settle; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED` and the site served 503 for ~2h15m until the Railway cutover. Do not "verify production" against Cloud Run, and expect GCP to delete the project's resources roughly 30 days after closure. `deploy-cloud-run.yml` / `deploy-cloud-run-staging.yml` are trigger-disabled but otherwise intact for that reason.
- **The 8 Cloud Scheduler cron jobs are NOT running.** They died with GCP and Railway has no replacement yet. Nothing is being lost — the notification outbox is durable in Postgres and attendance ingestion is inbound (the on-prem agent POSTs to `/api/attendance/raw-punches`) — but daily notifications, the outbox drain, iReports sync/reconcile and the recruitment/inbound intakes are all stalled until a scheduler is rebuilt. `src/lib/cron-control/*` is a dashboard over GCP Cloud Scheduler and is therefore also dead.
- Staging application: `https://phoenix-hr-staging-897559113412.us-central1.run.app` (Cloud Run
  service `phoenix-hr-staging`, project `phoenix-workforce-498619`, region `us-central1`; deployed
  2026-07-12, points at the staging Supabase project below, isolated from production — no shared
  third-party secrets. Deploys on a **daily cron only** (`cron: "40 3 * * *"`, 03:40 UTC) via
  `.github/workflows/deploy-cloud-run-staging.yml` — NOT on merge, and there is no `push` or
  `workflow_run` trigger. It redeploys the image production already built ("build once, deploy
  twice"), so if prod has not shipped the commit you care about, staging falls back to the newest
  prod image and will not contain your change. Same no-traffic/smoke-test/promote gate as
  production, reusing the env vars already configured on the Cloud Run service itself rather than
  any GitHub secret. A manual `gcloud run deploy` (or `workflow_dispatch`) still works if needed.
  Observed caution: across 2026-07-28..31 the scheduled runs actually fired ~11:30 UTC, ~8h after
  the configured 03:40 — treat the cron as "once a day, time not guaranteed", not a clock.)
- Vercel: fully legacy/decommissioned (old project `phoenix-workforce`) — never deploy to or verify against it.
- Staging Supabase project ref: `cifwmndunmlxjhyjugxa` (`Phoenix-HR-Staging`, Pro org, eu-central-1,
  created 2026-07-11 as a 1:1 clone of production; the prior free-tier staging project,
  ref `izhmxvgiktiafqusolot`, is GONE — as of 2026-07-27 `list_projects` returns only
  `cifwmndunmlxjhyjugxa` and `ozucdzovmcqvepbozvqf`, so that old ref resolves to nothing. Treat any
  doc, script, or prompt still naming it as stale. `scripts/staging-safe-rebuild.ts` is the one
  deliberate exception: its `currentStagingRef` pins the archived ref on purpose and says so.)
- Production Supabase project ref: `ozucdzovmcqvepbozvqf`
- GitHub Actions secret `STAGING_SUPABASE_SERVICE_ROLE_KEY` (added 2026-07-18): the staging
  project's service-role key, used only by `.github/workflows/ci.yml`'s `preview-smoke` job so the
  Playwright login-smoke test (CI_SMOKE_LOGIN_ID account) writes its expected session-rejection
  noise to staging instead of production `audit_logs`. The matching URL/anon key for that step are
  hardcoded in `ci.yml` (public/non-secret, RLS-protected).
- **`.env.local` points at PRODUCTION Supabase.** `pnpm run dev` mutates production data.

Environment meanings — **Local**: this machine or localhost. **Preview**: the deployment generated
for the current branch. **Staging**: a preview connected to the staging Supabase project.
**Production**: the public production domain and production Supabase project.

Never store passwords, tokens, API keys, service-role keys, JWT secrets, connection strings, or
other credentials in this file or in Git. Never assume a pasted preview URL is current.

## 4. Standing owner rules

These are the owner's own decisions, stated across many sessions. They are not suggestions.

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in both UI and chat.
- **Never truncate text with an ellipsis and never let text wrap** to multiple lines in the UI.
- When asked for N recommendations, give only the ones grounded in a real confirmed need. **Never
  pad a list to hit a number.**
- End every reply with a single recommended next step.

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead** —
  do not start implementing while the list is still being given.
- **Ask when the answer changes the outcome; decide when it does not.** He has asked both for
  "as many questions as needed to get it right" and for far fewer interruptions — the resolution is
  that scope, business rules, and data-correctness questions are always worth asking, while
  permission to do obvious low-risk work is not.
- Take ownership. Automate the work rather than returning a checklist he has to execute.

**How to build**

- **Before building any new UI, inspect the sibling pages in that module and match their exact
  design identity.** Never invent a one-off look.
- Admin shell: **desktop shows full tables/dashboards, mobile never does** — mobile gets cards.
- **One production deployment per task.** Bundle all phases into one PR; do not deploy per step.
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.

**Product rules that must not be "fixed" back**

- No payslip on any overview/landing page for any role — not the amount, not even the month label.
- Marketing Manager is hidden from the portal Incentive tab; GPM still sees it.
- The Organogram / AU seat model is the source of truth for org-structure and vacancy data.
- All SoS sales, historical and future, attribute to **today's** geography — never as-was.

## 5. Session, worktree, and parallel-work safety

Before editing, run `git status`, `git branch --show-current`, `git log -1 --oneline`,
`git worktree list`.

- Use one working tree per active session. **Never two interactive sessions in one folder** — the SessionStart lock warning is a hard stop, not advice. (A crashed session's lock self-expires after 2 hours; a lock whose PID is not a running process is stale.) A parallel session can `git checkout` a different branch in a shared tree while you are mid-edit.
- Start new work from the latest `origin/main` on a focused `codex/<task>` branch unless told otherwise.
- Never run `git clone`, `git init`, or anything that recreates the primary repository's `.git`.
- Never discard, overwrite, clean, reset, or revert changes you did not create. Treat unexpected changes as the owner's work. If the tree is dirty, classify and preserve it; continue only when your work can be isolated safely.
- **Never delete a `.xlsx` or `.pdf` file**, even a stray untracked one in a broken worktree being cleaned up. Scan any folder for them before removing it; if found and not identical to a git-tracked copy, move them into an `xlsx/` folder at the repo root instead.
- Immediately after creating a worktree, run `pnpm run worktree:sync-env`. `git worktree add` never copies gitignored files, so a new worktree has no `.env.local` until this runs — dev-auth and the dev server fail silently otherwise.
- Prefer worktrees as siblings (`git worktree add ../_wt-<task>`). If one must live inside the repo, its folder name must start with `_wt-` (or sit under `.codex-worktrees/` or `.claude/worktrees/`) — `tsconfig.json`, `eslint.config.mjs`, and `.gitignore` exclude those patterns, and a folder that matches none of them silently makes every local `typecheck`/`lint` several times slower (confirmed ~12x file count, 70s vs 8s). Locked worktrees under `.claude/worktrees/` belong to other live sessions — never remove them.
- Remove worktrees only with `git worktree remove`, only after approval, and only once `gh pr list --head <branch> --state merged` confirms the work landed. Run the xlsx/pdf rescue scan first. Stale worktrees must not accumulate — 26 folders was the historical failure mode.

**Machine limits (the laptop's RAM is soldered at 16 GB — it cannot be upgraded).** One dev server
at a time, ever. One typecheck/build at a time locally; parallel validation belongs to CI. Keep
total local sessions at **4 or fewer**. Route work by tier:

| Tier | Where | Use for |
| --- | --- | --- |
| **A — Cloud session** *(the default)* | Isolated cloud clone, ends in a PR | Any independent task not needing localhost browser verification, local files, or local credentials. Run on Sonnet by default. |
| **B — Local worktree** (max 2–3 woken) | Sibling `_wt-<task>` | Only tasks needing browser preview, dev-auth role sweeps, or local creds. |
| **C — Main checkout** (exactly one session — the control tower) | primary repo folder | Reviews, merge/deploy decisions, DB operations, deployed-env verification, worktree triage. Never feature edits. |

Only the control-tower session rewrites the shared memory index; other sessions may append memory
files but never reorganize the index. Cloud sessions cannot see local state — put everything they
need in the task prompt.

## 6. Approval rules

Pipeline: `inspect → isolate → implement → validate → summarize → approve delivery → commit/push/PR
→ verify CI → approve merge → verify production`.

**Automatic** within the requested scope: reading files, searching code, inspecting Git state and
logs, reviewing diffs, creating a branch or worktree, editing requested files, running validation,
applying safe local fixes, staging task-related files.

**One bundled approval** may authorize commit + push + open/update PR together, when the owner's
message explicitly requests those actions ("implement, commit, push, and open a PR"). Do not ask
again unless scope, risk, target, or validation result materially changes.

**Always require separate, explicit, plain-language approval before:**

- Merging a PR or otherwise updating `main`.
- Applying a migration to staging or production (production needs its own, separate approval).
- Deploying to production or changing production environment variables.
- Changing authentication, authorization, RLS, payroll, employee-lifecycle data, or other high-risk live behavior.
- Rebasing, resetting, deleting a branch or worktree, force-pushing, rewriting history, rolling back, or any destructive Git command.
- Bulk updating or deleting live data, destructive SQL, or any irreversible operation.
- Editing any of the three protected files listed in [CLAUDE.md](CLAUDE.md).

Approval covers only the explained action, scope, environment, and target. Silence, an approval for
another task, green validation, and **the absence of a permission prompt** are all not approval. For
destructive work, show the target, expected impact, backup/recovery plan, and verification plan
before asking.

**Git hygiene.** Review `git status`, `git diff`, `git diff --cached` before committing. Stage only
files owned by the task. Never commit `.env*`, `.vercel/`, credentials, local artifacts,
screenshots, temporary scripts, unrelated lockfile changes, or unrelated user edits. Use
conventional messages (`fix(module): reason`, `feat(module): capability`, `docs(agents): change`).
`main` is production — never edit it directly; a direct push requires action-specific approval and a
justified emergency. `delete_branch_on_merge` is on, so GitHub deletes the **remote** branch
automatically; the local branch and worktree survive and still need approval to remove.

## 7. Validation

Match validation to blast radius. **While iterating on UI/pages, run typecheck+lint once after the
batch of edits — not after each one; run build and tests when the change reaches the tiers below or
when asked.** `pnpm run check:harden` before any commit, push, PR, migration, or deploy.

| Change type | Minimum validation |
| --- | --- |
| Docs or repo instructions only | Review diff, formatting, links, secret exposure |
| Narrow TypeScript/JavaScript change | Lint, typecheck, targeted tests |
| Shared runtime, app/API route, server component, env, or deployment behavior | Lint, typecheck, tests, build |
| UI workflow | Relevant code checks plus browser verification at desktop and mobile sizes |
| Migration, view, function, RPC, grant, or policy | Migration checks, SQL review, target confirmation, schema/security review, staging verification after approval |
| Auth, RLS, payroll, HR lifecycle, sales, permissions, executive reporting | Full checks, role-based tests, failure-state checks, explicit risk review |

Prefer repository scripts over improvised commands. Never present a known-broken change as ready.
Report failures your change caused separately from pre-existing ones. When a data source is
unavailable, verify the UI says so rather than showing a misleading zero.

**Role-based testing.** For permission-sensitive work, test the affected roles including denial
paths. Sales: Super Admin, CEO, National Sales Manager, Regional Manager, District Manager.
Coaching: Super Admin, CEO, SFE Manager, Training Manager, and Medical Rep when employee review is
affected. HR: Super Admin, CEO, HR Specialist, and Employee when portal behavior is affected. Do not
claim role safety from code inspection alone when real role testing is possible.

**Deploy verification.** `gh run list --workflow=deploy-cloud-run.yml --limit 3` (production) or
`--workflow=deploy-cloud-run-staging.yml` (staging); `gcloud run revisions list --service phoenix-hr
--region europe-west3` for what actually serves traffic. A PR is merge-ready only when required CI
passes, staging is healthy, changed workflows pass smoke testing, and required staging migrations
are verified. After a runtime-impacting production deploy, verify the public domain, smoke-test the
changed workflow, and inspect production logs. When a page fails, capture the visible error, browser
console, network/API response, deployment logs, and database/RLS evidence before proposing a fix.

## 8. Supabase and data safety

- All schema changes must be migration-based, repeatable, reviewable, and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref, resolving it with `list_projects` rather than trusting a ref pasted in a prompt or copied from an older doc — this line once named a long-deleted staging project, so "verify the ref" confirmed a dead value and the obvious recovery pointed at production.
- Both Supabase MCP servers (`supabase-staging`, `supabase-production`) can see BOTH projects. **The server name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.**
- Use ONLY those two named servers. Any UUID-named Supabase tool (a claude.ai account connector, e.g. `mcp__b345e47e-…`) has an unverifiable identity and is deny-listed — never call it, and flag it if it reappears.
- Before destructive or bulk live-data work, inventory the target, create or verify a backup, show the exact mutation, and define post-change counts or checks.
- Verify RLS, grants, RPC authorization, service-role boundaries, and browser-role exposure whenever permissions or data access change. Service-role credentials and privileged operations stay server-only.
- Visibility in this app is **application-scoped, not RLS-scoped** — most code paths use the service-role client. Changing auth or sessions will not move what a user can see, but a `?? getSupabaseAdmin()` fallback is a silent fail-open.

## 9. Stop conditions

Stop before delivery or mutation and explain the blocker when:

- The target branch, worktree, environment, project, or requested scope is uncertain.
- Unrelated changes cannot be isolated safely.
- Validation fails and the proposed action would publish known-broken work.
- A PR is conflicted, required checks are failing, or the preview is not the expected deployment.
- A secret may have been exposed. Do not repeat it; recommend revocation and replacement.
- A destructive action lacks a verified target, backup, recovery path, or explicit approval.
