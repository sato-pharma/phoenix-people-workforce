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
- **Almost nothing prompts** (see rule 1.5) — auto mode waves most routine work straight through.
  You are the last line of defense.

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
5. **The absence of a permission prompt is not approval.** `permissions.defaultMode` is **`auto`**
   in user-level `~/.claude/settings.json` — read live 2026-08-12. It was `bypassPermissions` from
   2026-08-01 (set after the risk was disclosed twice), which gated nothing at all; the owner
   reverted it, confirmed 2026-08-09. So the repo's `permissions.ask`/`deny` lists are no longer
   outranked and real dialogs do fire again. What auto mode still does **not** do is gate the work
   that matters: its classifier silently auto-approves a large share of routine calls, and no mode
   has ever prompted on a judgement call. **Every approval rule in section 6 is therefore
   behavioral: ask in plain words and wait for a plain answer.** Never offer a prompt that did not
   appear as evidence you were allowed, and read the settings file before asserting which mode is
   on — this paragraph named the wrong mode from the revert until 2026-08-12.

## 2. Hard-Learned Rules (each cost a real incident — do not relearn them)

Evidence for these — dates, PR numbers, billing figures, measurements — is in
[docs/agents-incident-history.md](docs/agents-incident-history.md). Read it before changing branch
protection, CI cost, the deploy path, or the region.

- **Never use `gh pr merge --auto`.** `main` is branch-protected (`enforce_admins: true`) with **4 required status checks** — `validate`, `lint`, `typecheck`, `secret-scan` — that **DO gate every merge**. `allow_auto_merge: false`, so `--auto` is rejected anyway. Required reviews is **0** (a solo owner cannot approve his own PR; CI is the gate). Merge only with an explicit plain `gh pr merge` after separate owner approval.
- **Do NOT run `gh pr update-branch` reflexively.** A PR behind `main` is no longer refused — "require branches to be up to date" is **OFF** (`strict: false`, owner-approved 2026-08-05) because it was the dominant Actions cost and hit the spending cap, freezing every merge. Each run costs ~16 Actions minutes and discards the prior green CI. Run it **only when the change genuinely depends on something newly on `main`**, never as merge ceremony.
- **When you do run `gh pr update-branch`, it acts on the SERVER — your local branch is then stale.** The next `git push` is rejected with *"remote contains work that you do not have locally"*, which reads like someone else pushed. Always `git fetch` and `git merge --ff-only origin/<branch>` before committing anything more. It also moves the head SHA, so **CI re-runs and the previous green result no longer applies** — never merge on the older run.
- **A merge to `main` SHIPS TO PRODUCTION IMMEDIATELY.** This reversed on 2026-08-01 and is the single most important thing to relearn. Railway deploys on push, at full traffic, with no cron wait, no staged rollout, and no smoke test. CI gates the merge, but the merged commit then ships instantly. **Never merge anything to `main` you are not willing to have serving employees within minutes.** To confirm what is actually live, request `/api/healthz` and read `revision` — not the workflow list.
- **There is no staging application.** It died with Cloud Run; only the staging *database* survives. Any rule elsewhere in this file requiring staging verification currently has nothing to run against — say so plainly rather than pretending the gate exists.
- **Full validation gates must not trust warm TypeScript caches.** `pnpm run check:harden` / CI are authoritative; a bare warm `tsc` can report a false green. For manual full checks use `tsc --incremental false`.
- **Never foreground-watch a long pipeline** (CI run, deploy, big script). Launch it in the background and check at batched checkpoints.
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), not the cookie flow — cookie-based role switching logs the real user out.
- **Merged-branch checks must be squash-aware.** PRs merge by squash, so a merged branch is never an ancestor of `origin/main` — `git branch --merged` is always wrong here. Use `gh pr list --head <branch> --state merged`.
- **A regression test only counts if you break the fix and confirm the new test's own headline assertion fires.** "The suite went red" is not proof — twice it was an unrelated old test or an adjacent assert.
- **`list_migrations` reports the migration ledger, not reality.** To prove an object exists, query `pg_class`/`pg_proc`.
- **Auto-git workflows are permanently banned.** Auto-executing commit/push/PR/merge was tried and reverted **twice**. Always ask first.

## 3. Stable Environment Facts

History and verification detail: [docs/agents-incident-history.md](docs/agents-incident-history.md).

- Production application: `https://phoenix-hr.satopharma.com` — **served by Railway since 2026-08-01, no longer Cloud Run.** Railway service `phoenix-people-workforce`, project `Phoenix-HR-Workforce`, region **`europe-west4-drams3a` (Amsterdam, EU West)**, 1 replica, deployed from this repo on push. **The region is deliberately colocated with the Frankfurt Supabase project (`eu-central-1`) and near the Cairo users — if production is ever re-platformed, it must stay in Europe** (measured: ~204ms from `sfo` vs ~75ms from `europe-west4`). Also reachable at `https://phoenix-people-workforce-production.up.railway.app`; Cloudflare holds `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied.
- **GCP is DEAD, not standby.** Billing closed 2026-08-01; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`. Do not "verify production" against Cloud Run. `deploy-cloud-run.yml` / `deploy-cloud-run-staging.yml` are trigger-disabled but intact.
- **The production scheduler is the third-party `cron-job.org`.** Automation is **running, not stalled**: daily notifications, the outbox drain, and iReports sync/reconcile all fire from that account. The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** — a red herring, not proof anything is down. **Do not tell the owner notifications/outbox/iReports are stalled without checking `cron-job.org` first.** It caps request timeout at 30s, so a long route logs a false `Failed (timeout)` while the server still finishes the work. `src/lib/cron-control/*` is a dashboard over the dead GCP scheduler and remains inert.
- Staging application: **GONE.** Only the staging *database* survives. Do not "verify against staging" — there is no staging app to serve it.
- Vercel: fully legacy/decommissioned (old project `phoenix-workforce`) — never deploy to or verify against it.
- Staging Supabase project ref: `cifwmndunmlxjhyjugxa` (`Phoenix-HR-Staging`, Pro org, eu-central-1). The prior free-tier ref `izhmxvgiktiafqusolot` is GONE and resolves to nothing — treat any doc or prompt still naming it as stale.
- Production Supabase project ref: `ozucdzovmcqvepbozvqf`
- GitHub Actions secret `STAGING_SUPABASE_SERVICE_ROLE_KEY`: the staging service-role key, used by `ci.yml`'s login-smoke step (so its noise lands in staging, not production `audit_logs`) and by both staging legs of `migration-drift-check.yml`. **There is no `preview-smoke` job any more** — the smoke test is a step inside `validate`.
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
- **Ask business-fact questions as an XLSX with dropdowns, not in prose** (his rule, 2026-08-03,
  after classifying 16 Arabic-named bricks this way). Whenever the doubt is "which of these does
  each of these belong to" — bricks to areas, areas to regions, people to seats, products to lines —
  build one row per item with a locked data-validation list of the allowed answers, send the file,
  and read the answers back. He fills it and returns it. This applies **everywhere in the repo**, not
  just Source of Sales. Include whatever context makes the call easy (current value, recent sales)
  and a free-text Note column. Never guess an item to avoid asking, and never hand back a list of
  items for him to answer in chat.
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
- **`git worktree remove` leaves a HUSK, and nothing built into git can see it.** It deletes tracked files and the registry entry but leaves the gitignored payload — `node_modules/` and `.next/` — on disk. What remains has no `.git` file and no registry entry, so `git worktree prune` cannot find it and the SessionEnd guard `.claude/hooks/worktree-exit-guard.mjs` exits early because `git rev-parse --git-dir` resolves nothing. Husks therefore accumulate forever and are invisible to every "list the worktrees" check. **Run `pnpm run repo:doctor`** ([scripts/repo-doctor.mjs](scripts/repo-doctor.mjs)) after any removal: it reports by default, `--fix` deletes only husks proven to hold zero files, and it refuses to act while more than one Claude Code session is live. Anything holding even one file is reported NEEDS REVIEW and never touched.
- **Worktree payload — not git, not tsc — is what makes this checkout feel slow.** Measured 2026-08-04: **1,887,882 file paths, 67s to walk**, against 4,107 tracked files — a 460x amplification, ~99% of it worktrees. Tools honouring `.gitignore` never see it, which is why validation looks healthy while the session crawls; what pays is agent file search, `grep -r`, `dir /s`, naive watchers. **Do not tune `tsconfig`/`eslint` for this — those excludes are already correct.** Retire merged worktrees and clear husks instead. Cost is path COUNT, not gigabytes (pnpm hardlinks).

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

Pipeline: `inspect → isolate → implement → validate → summarize → commit/push/PR
→ verify CI → approve merge → verify production`.

**The default decision is: PROCEED.**

For all tasks, complete every pre-approved step automatically and ask for permission ONLY when you reach one of the two protected actions below. Do NOT repeatedly ask for confirmation ("Should I proceed?", "Can I make this change?") for pre-approved actions. If a task does not require a protected action, complete the entire task without asking for permission.

**PRE-APPROVED ACTIONS (Proceed automatically):**
- Reading, searching, and auditing the codebase
- Editing or creating files, refactoring, fixing bugs
- Running local commands, tests, lint, type checks, builds, and validation
- Installing or updating dependencies when required for the task
- Creating branches, worktrees, commits, and pushing to non-production branches
- Creating, updating, or reviewing Pull Requests (merging requires approval)
- Resolving merge conflicts on the working branch
- Creating database migration files, testing migrations locally or in non-production
- Running Supabase CLI commands that do NOT modify production
- Updating documentation, configuration, or CI/CD configuration
- Deploying or testing in local, preview, development, or staging environments
- Investigating logs, errors, or infrastructure (GitHub, Railway, Supabase)
- Running safe diagnostic or repair actions outside production

**PROTECTED ACTIONS (Stop and require separate, explicit approval before):**
1. Merging any branch or Pull Request into `main` or any production branch.
2. Running or applying any database migration against the production database/environment.

**Git hygiene.** Review `git status`, `git diff`, `git diff --cached` before committing. Stage only
files owned by the task. Never commit `.env*`, `.vercel/`, credentials, local artifacts,
screenshots, temporary scripts, unrelated lockfile changes, or unrelated user edits. Use
conventional messages (`fix(module): reason`, `feat(module): capability`, `docs(agents): change`).
`main` is production — never edit it directly; a direct push requires action-specific approval and a
justified emergency. `delete_branch_on_merge` is on, so GitHub deletes the **remote** branch
automatically; the local branch and worktree survive and still need approval to remove.

## 7. Validation

**Validate ONLY when the owner says so. Never on your own judgement.**

No lint, no typecheck, no tests, no build until he says the work is done. Not between edits, not
"once per task", not because a change feels finished — **he decides when the work is finished, not
you.** (This replaced "validate once per task" on 2026-08-10: that wording still left the agent
deciding where a task ended.) He iterates in long sessions and changes one file many times;
re-validating work that is about to change again proves nothing and costs him minutes.

Verifying a UI change in the browser is NOT validation and needs no permission — reload and look.
That is seconds, and it is how defects actually get found.

When he says done, match the tier below to the blast radius and run it **once**.

`pnpm run check:harden` then runs **once before you push** — not before every local commit. A commit
on a feature branch ships nowhere, and CI re-runs the identical content (`validate` + `lint` +
`typecheck` jobs, all required status checks) on the PR head commit and blocks the merge if it is
red. Migrations and production deploys still get their own run immediately before the action,
because those are not covered by a PR's CI.

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

**Deploy verification.** Production is Railway auto-deploy on push to `main` — there is no Cloud Run
workflow to watch and no `gcloud`/`gh run` deploy job that means anything (both are dead on GCP
billing). Confirm a deploy through the GitHub deployments API
(`gh api repos/Gawish-1997/phoenix-people-workforce/deployments` — rows read
`Phoenix-HR-Workforce / production … "Deployed to Railway"`) or `railway status`, and confirm what
actually serves traffic by requesting `/api/healthz` and reading `revision` (the running commit
SHA). There is no staging app to check. After a runtime-impacting production deploy, verify the
public domain, smoke-test the changed workflow, and inspect production logs (`railway logs`). When a page fails, capture the visible error, browser
console, network/API response, deployment logs, and database/RLS evidence before proposing a fix.

## 8. Supabase and data safety

- **Supabase writes are pre-authorized end to end — NO approval prompt** (owner's `autoMode` grant in `~/.claude/settings.json`, applied by hand 2026-08-02, which deliberately removes the §6 gate for Supabase). It covers the `supabase-staging` and `supabase-production` MCP servers, the owner's connector `mcp__45bb6356-…`, and the `supabase` CLI (`supabase` / `npx` / `pnpm` / `pnpm dlx`, incl. `db push`), on staging AND production (`ozucdzovmcqvepbozvqf`) — every read tool and every write tool: `execute_sql` mutations, `apply_migration`, bulk and destructive SQL. **You do NOT wait for a separate approval.** The one standing condition: **announce any destructive or bulk PRODUCTION change (it can mutate real payroll data) in plain words before you run it, and give the owner a chance to stop it** — the removed prompt is a UI gate, not licence to skip telling him. (This grant does NOT cover creating/deleting a project or reading secrets — see §6.) `mcp__b345e47e-…` stays denied.
- All schema changes must be migration-based, repeatable, reviewable, and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref, resolving it with `list_projects` rather than trusting a ref pasted in a prompt or copied from an older doc — this line once named a long-deleted staging project, so "verify the ref" confirmed a dead value and the obvious recovery pointed at production.
- Both Supabase MCP servers (`supabase-staging`, `supabase-production`) can see BOTH projects. **The server name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.**
- Prefer those two named servers for all routine work. Any UUID-named Supabase tool (a claude.ai account connector) has an identity you cannot verify from its name alone, so it stays deny-listed by default — never call an unrecognized one, and flag it if it reappears. `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087__*` remains denied.
- **Owner-confirmed exception (2026-08-02):** `mcp__45bb6356-8105-4482-9464-25bfd754baec__*` is the owner's own claude.ai Supabase connector. He confirmed ownership and instructed its removal from the deny list, so it is callable. Note its consent grant is **broader than either named server** — read+write on Secrets, Environment, and Projects, meaning it can read project secrets and create or delete projects. Reach for the named servers first; use this one only when it is actually the right tool. Its DB writes fall under the pre-authorized grant above (announce destructive/bulk prod changes; no wait), but **creating/deleting a project or reading secrets is NOT covered — get an explicit go for those** (see §6).
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
