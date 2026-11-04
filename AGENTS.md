# Phoenix Workforce — Agent Rules

Operating rules for every AI agent in this repository. Codebase reference: [docs/architecture.md](docs/architecture.md);
daily commands and the protected-file gate: [CLAUDE.md](CLAUDE.md). Higher-priority platform or system
instructions take precedence. When instructions conflict or scope is unclear, stop before the risky action
and explain the conflict plainly.

**This file is re-sent on EVERY request of every session, so it holds cues only** — the rule plus the one
detail needed to obey it. 🔴 **The full wording, owner quotes and evidence of every rule here are in
`docs/agents-md-full-2026-10-24.md`** (shrunk on his word, 2026-10-24, to stop the weekly usage draining) —
read the matching section there when a cue is not enough. A rule for ONE module goes in its memory
(`.claude/rules/<module>.md`, §2.2); a session trap goes in `docs/agents-session-traps-clusters.md`; the
account always goes in `docs/`. Measure before adding (`docs/memory-index-budget.md`).

**Accounts, read on demand:** payroll, sales/closing, recruitment, CRM, exports → `docs/agents-owner-rules.md`;
deploy, cron, production data → `docs/agents-production-hooks.md`, `docs/environment.md`; worktrees and
machine → `docs/agents-worktree-and-machine-limits.md`; shell, git, CI → `docs/agents-session-traps.md`;
AUTORUN → `docs/agents-autorun.md`; why a §2 rule exists → `docs/agents-incident-history.md`. Every memory
note is filed in `scripts/module-memory/assignments.json` and CI refuses an orphan; a backticked slug here is
a cue to open that note (`docs/agents-memory-map.md`).

## 0. How this repo is actually run

One owner runs everything — **not a career engineer**, the business owner of a live HR platform a real
pharmaceutical company runs payroll, attendance and sales on; real employees are paid from this data.
~46 commits a day, more fixes than features, sessions for hours or days, often after midnight: assume he
cannot hold the whole system in his head at 4am — that is your job. He writes short terse instructions and
expects you to work out the scope; explain like to a smart non-engineer.

## 1. The five rules that prevent the rework

1. **Show the proof, never the claim** — paste the count, revision id, row or HTTP status; if you did not
   run it, say so. Being confidently wrong is what costs a day.
2. **Verify against live reality** — a ledger is not the database, a merged PR is not a deploy, a green CI
   is not a working page, a memory is a point-in-time note.
3. **Finish every phase**, in order; if one is blocked, say which and why.
4. **After compaction, distrust yourself** — a replayed summary reads like a live instruction; re-check.
5. **No permission prompt is not approval** — sessions run `--permission-mode auto`; every approval rule
   in §6 is behavioural: ask in plain words and wait for a plain answer.

## 2. Hard-Learned Rules (each cost a real incident)

Why each exists: `docs/agents-incident-history.md`.

- **Never use `gh pr merge --auto`.** `main` is branch-protected with **2 required checks** — `validate`, `checks`; `allow_auto_merge: false`. 🔴 That list has rotted five times and `lint`, `typecheck`, `test` are NOT check names — read `branches/main/protection/required_status_checks` live; `node scripts/check-required-checks.mjs` catches a rotation.
- **Never commit onto local `main` in the primary.** Branch first; if you did: `git branch <name> <sha>`, then `git reset --keep origin/main` (never `--hard`), then a PR.
- **Never run `gh pr update-branch` reflexively** (`strict: false`, ~16 Actions minutes); it acts on the SERVER — `git fetch` and `git merge --ff-only origin/<branch>` before your next push.
- **A merge to `main` SHIPS TO PRODUCTION once that commit's CI is green** — never merge what you would not have serving employees within minutes.
- 🔴 **THE DEPLOY IS HELD BY THE RELEASE GATE, AND IT FAILS BY NOT SHIPPING — SILENTLY.** The new container answers `/api/readyz` 503 until `ci.yml`'s `release-gate` recorded `checks` (lint, typecheck, suite) passing on that commit — the CI build left the gate 2026-11-04, his "Tests only"; red CI = the old version keeps serving. Read `/api/healthz` `revision`, never the merge; never remove `push: main` or `release-gate`; never cancel a stuck `main` run and walk away — `gh run rerun <id>`. Account: `docs/deployment.md`, "The release gate".
- **A hand-run typecheck must start cold:** `tsc --incremental false`.
- **Never foreground-watch a long pipeline** — background it and act on the notification.
- **Batch look-arounds** — the next few reads, greps or status checks go as parallel calls in ONE step (`docs/hook-dispatcher.md`, "batch-nudge").
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), never the cookie flow.
- **Merged-branch checks are squash-aware** (`gh pr list --head <branch> --state merged`), and 🔴 a REUSED name returns the OLD PR — ask by NUMBER and check its files on `main`. `a-reused-branch-name-finds-the-old-merged-pr`
- **A regression test counts only if you break the fix and see its own assertion fire.**
- **`list_migrations` reports the ledger, not reality** — query `pg_class`/`pg_proc`.
- **Commit, push and open the PR WITHOUT asking; ALWAYS ask before merge** (owner, 2026-09-16; the scheduled PR merger was REMOVED 2026-10-24, §6). Stage only the task's files.

### 2.1 Session-level traps

**The traps live in [docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md)**, and `.claude/hooks/trap-injector.mjs` injects the matching cluster's headlines once per session. 🔴 **A headline is a trap's first sentence, not the rule** — search the clusters file for its words before acting; **the hook fails open and silent**, so with no trap block for your kind of work, read the cluster yourself. Clusters: Shell and tooling · Git · CI and PRs · Migrations · Database, grants and RLS · Probing production · Validation · Memory · Parallel sessions · Worktrees · Next.js runtime · Browser and dev-auth · Machine ceiling.

**Reachability roster** — `tests/memory-index-reachability.test.ts` requires this one slug here; every other relocated note is named in its own `.claude/rules/<module>.md`, which loads with the module:

`tailwind-merge-strips-custom-named-font-sizes`

### 2.2 Memory — module memory and the index

How it works: `docs/module-memory.md`.

- 🔴 **A MODULE-MEMORY LIMIT IS NEVER PUT TO THE OWNER** — a pointer over its margin, a file near its cap, an orphan, a dead glob, a stale block: split, file, rebuild and ship it in the PR you are already opening (`docs/module-memory.md`, "Limits").
- 🔒 **Each module's rules and notes live in `.claude/rules/<module>.md`**, loaded when a session reads a file of that module; `.claude/hooks/module-memory-injector.mjs` covers work that opens none, and fails open — open the file yourself if it has not appeared.
- 🔒 **Route a new rule by where it applies** — one module → its `## Rules` (a changed rule is an EDITED line); true everywhere → here; a session trap → the clusters file. **Never delete a rule to make room.**
- **A new memory note goes in `MEMORY.md` under `## Inbox`**; the fold (`node scripts/module-memory/fold.mjs --apply`, 09:00, 15:00 and 21:00 Cairo) files it in ONE PR.
- 🔴 **`tests/module-memory.test.ts` refuses an orphan note, a dead glob, a file over its cap, a stale generated block or a rules file with no `paths:`** — never hand-edit a generated block; edit `scripts/module-memory/modules.mjs` or `assignments.json` and run `node scripts/module-memory/build.mjs`.
- **`MEMORY.md` is silently truncated at 25 KB / 200 lines** — never move a module fact back into it.

<!-- module-memory:directory:begin — generated by scripts/module-memory/build.mjs -->
**79 modules**, each one a `.claude/rules/<id>.md` whose own `paths:` holds every glob. The id → title → globs table is in `docs/module-memory.md` ("The module directory"); `ls .claude/rules/` lists them. You do not need either to reach a module — Claude Code loads the matching file the moment you open one of its files, and `.claude/hooks/module-memory-injector.mjs` matches work that opens no file.
<!-- module-memory:directory:end -->

### 2.3 Production and approval hooks

Account: `docs/agents-production-hooks.md`; module-specific production hooks are module memory.

- **A deploy applies NO migrations, and auto-deploy can silently SKIP** — read `/api/healthz` `revision`.
- 🔴 **Production has NO PITR — 7 daily backups are the whole recovery story.** Say so before any bulk or destructive change; never restore a backup in place.
- **A LOCAL run writes PRODUCTION but skips every email** (the local Resend key cannot send) — send from production with `railway run`.
- **STAGING cannot rehearse a PRODUCTION shape.**
- **`isProductionRuntime()` reads `APP_ENV || VERCEL_ENV || NODE_ENV`** — `APP_ENV` must stay set on staging; staging email is safe only because `PHOENIX_EMAIL_FORCE_TESTING` is set. Treat `!isProductionRuntime()` as an auth fallback with suspicion.

## 3. Stable Environment Facts

The full list (services, region, domains, crons, secrets): `docs/environment.md`, "Stable environment facts".

- Production: `https://phoenix-hr.satopharma.com`, Railway service `phoenix-people-workforce`, environment **`production`**, region `europe-west4-drams3a` — **it must stay in Europe.**
- Staging: `https://phoenix-people-workforce-staging.up.railway.app`, on the staging Supabase project. **GCP and Vercel are DEAD.**
- **The production scheduler is `cron-job.org`**; a green outbox cron proves nothing — read `drainHealth`. The drain alarm is deliberately never email.
- **`.env.local` points at PRODUCTION Supabase** — `pnpm run dev` mutates production data.
- **Supabase project refs — the complete list `list_projects` returns:**

  | Ref | Name | Region | Org | What it is |
  | --- | --- | --- | --- | --- |
  | `ozucdzovmcqvepbozvqf` | Phoenix HR | eu-central-1 | `rovnkzmhokgsruftjsaw` | **PRODUCTION** — real payroll data |
  | `cifwmndunmlxjhyjugxa` | Phoenix-HR-Staging | eu-central-1 | `rovnkzmhokgsruftjsaw` | **STAGING** |
  | `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | **`tvweawmrjrekvepkcxzs`** | unrelated to this app — **different organization** |

  Dead refs — anything naming one is stale: `izhmxvgiktiafqusolot` and `oaifhavixhdtwmseshff`. Neither region nor org is a guard — resolve with `list_projects` (§8).

Never store credentials in this file or in Git. Never assume a pasted preview URL is current.

## 4. Standing owner rules

His decisions, not suggestions. Account of each: `docs/agents-owner-rules.md`.

- 🛑 **THE MOBILE APP IS FROZEN — DO NOT WORK IN IT, TOUCH IT, PLAN IT, MENTION IT OR ASK HIM ABOUT IT, UNTIL HE LIFTS THIS IN HIS OWN WORDS** (owner, 2026-09-29). The web app is the whole scope: no edit under `mobile/`, no Expo/EAS build or dispatch, no mobile PR, and no words — not in a `Next step:` line, a plan, a summary or a question. A mobile defect you notice is left alone. Only HE lifts it; if you cannot tell, it is still frozen; every other mobile rule is DORMANT. Refused by `.claude/hooks/mobile-freeze-guard.mjs`. Account: `docs/agents-owner-rules.md`, "The mobile-app freeze". `the-mobile-app-is-frozen-until-he-lifts-it`

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in UI and chat.
- **Never truncate text with an ellipsis** — where it collides with the no-horizontal-scroll rule, wrapping wins.
- Recommend only what a real confirmed need grounds; **never pad a list to hit a number.**
- **Open EVERY reply with one `Next step:` line — FIRST, not repeated at the end — ending in curly-quoted words he could send as-is** (owner, 2026-09-18), naming a real target; never filler, a re-check, "continue" or a closing word. `recommendation-goes-first-not-last`
- 🔴 **The quoted words are a message to CLAUDE** — never a physical act or a message to a person; put those in the prose with the exact path. `never-put-his-physical-actions-in-the-next-step-box`
- 🔴 **The words go to whichever surface the running build gives** — ghost text, or `mcp__ccd_turn__wrap_up`'s `actions[0].message` verbatim whenever that tool is in the session's own tool list. `the-turn-box-took-the-ghost-text`

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead.**
- **Ask when the answer changes the outcome; decide when it does not.**
- Take ownership — automate the work rather than hand back a checklist.
- 🥇 **EVERY QUESTION TO HIM IS A MULTIPLE-CHOICE QUESTION, NEVER PROSE** (owner, 2026-10-18) — `AskUserQuestion`, 2–4 short options, recommended first; never end a reply with an open question or an offer in prose. `ask-business-questions-as-in-chat-multiple-choice`

**How to build**

- **Before building new UI, match the sibling pages' exact design identity** — never a one-off look.
- Admin shell: **desktop shows full tables and dashboards, mobile gets cards.**
- 🔴 **A live evidence photo's own GPS is the primary source of trust** (owner, 2026-10-18) — it outranks a declared brick, area or address; an implausibly far pin is "not usable", never an accusation (`docs/agents-owner-rules.md`).
- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, mobile AND desktop.** `<table className="w-full table-fixed">` + `<colgroup>`; fit by MERGING columns, never shrinking type; `overflow-x-auto` over a `min-width` IS the bug; a table in a grid cell switches on its own width (`@container`). `never-horizontal-scroll-always-mobile-and-desktop-friendly`
- 🔒 **THE ONE FORM DESIGN — every form wears the Adverse Drug Reaction wizard's skin** (owner, 2026-10-06): strings from `src/components/ui/form-tokens.ts`, parts from `form-kit.tsx`; the ratchet in `tests/form-design-system.test.ts` is at ZERO, never raise it. `the-one-form-design-every-form-wears-the-adr-wizards-skin`
- 🔒 **THE SQUARE-EDGE GOLDEN RULE — no round corners, anywhere.** Measure computed `border-radius`; restoring polish from history re-rounds corners. Pinned by `tests/admin-shell-palette-scope.test.ts` and `tests/hiring-pack-paper-editor.test.ts`.
- 🔒 **THE DOCUMENT IDENTITY — every company document wears `SATO-DIS-2026-01 v1.0`**; the ink rule (no filled areas but the 6% zebra), government forms exempt; the papers he ticked "change" wear the HR premium identity; the Arabic logo is never a masthead. Module: `src/lib/hiring-pack/house-identity.ts`. `the-house-document-identity-standard`
- **One production deployment per task** — bundle the phases into one PR.
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.
- 🔴 **EVERY AI CALL GOES THROUGH ONE DOOR** (owner, 2026-10-24) — `createOpenAiResponseText` (`src/lib/ai/`) or `runWithSalesAiFailover`; ask `hasAiApiKey()`. `tests/ai-one-door.test.ts` refuses a second door.

**Product rules that must not be "fixed" back** — each lives in its module's memory. Kept here:

- 🔒 **`phoenix_app_shell=1` defaults FALSE and must stay** — removing it strips the web portal's chrome. Pinned by `tests/native-web-handoff.test.ts`.
- ⏸️ **The DORMANT mobile rules live in `docs/agents-owner-rules.md`** — read them only when he lifts the freeze: `the-mobile-app-is-a-shell-over-the-web-portal` · `managed-play-cannot-reach-the-rep-tablets`
- 🔒 **THE MONTHLY-CLOSING SOURCE-OF-TRUTH GOLDEN RULE** — every SALES and every TARGET figure, system-wide, comes through the closing engine and equals the PUBLISHED closing. Weekly Sales, Marketing ROI and the **Business Review pack** are the carve-outs — never invent a fourth. 🔴 **THE BUSINESS REVIEW READS THE LIVE ENGINE, NOT THE PUBLISHED SNAPSHOT** — never "fix" it back. Account: `docs/agents-owner-rules.md`, "The Business Review reads live". `sos-monthly-closing-is-the-only-sales-truth`

## 5. Session, worktree, and parallel-work safety

Before editing: `git status`, `git branch --show-current`, `git log -1 --oneline`, `git worktree list`. Account: `docs/agents-worktree-and-machine-limits.md`.

- **One working tree per session; never two sessions in one folder.** A lock refreshed inside 15 minutes is live → isolate with `node scripts/new-session.mjs <task>` and carry on without asking; a lock expires 2 hours after its last refresh, and that AGE is the ONLY staleness test.
- New work starts from `origin/main` on `codex/<task>`. Never `git clone`/`git init` the primary; never discard, clean or reset changes you did not make; **never delete a `.xlsx` or `.pdf`**.
- **`node scripts/new-session.mjs <task>`** makes `_wt-<task>` with `node_modules` junction and env files (`--status`, `--repair`, `--remove <task>` only after approval). `node scripts/sync-worktree-env.mjs` points a sibling's memory at the primary's.
- **A worktree session writing into the primary is denied** (`.claude/hooks/primary-write-guard.mjs`).
- **Never `pnpm install`, `pnpm run` or `pnpm exec` inside a worktree** — they purge the junction (bash-guard C6). Dev server: `node scripts/dev-server.mjs --port 3000`, only when live free RAM allows; `phx-live` and `phx-preview` are retired — never mention them.
- **A dev server YOUR session started is yours to stop, by PORT; one HE or another session started waits for his word.** `i-may-stop-a-dev-server-i-started-myself`
- In-repo worktrees start with `_wt-`; locked `.claude/worktrees/` belong to live sessions. After a removal run `pnpm run repo:doctor` (it pages production GoTrue unless `--no-auth`).
- **`xlsx/` backup has holes** — only top-level sheets of the PRIMARY's `xlsx/` and the named `BACKED_UP_SUBDIRS` are copied; never call a sheet covered without checking.

**Machine:** 16 GB RAM; FREE RAM binds, read it live; one dev server at a time; `mem-watchdog.ps1` reaps a typecheck, build or test under 1,800 MB free. Fewer open SESSIONS is the only lever, and it is his call alone.

**ROUTING GOLDEN RULE — route by what a task NEEDS, default to cloud:** a browser look, a dev-auth sweep or local files → local worktree; a decision, merge/deploy or the database → the main checkout; everything else → cloud. 🔴 **A cloud session is Phoenix-blind** (repo and prompt only) — send it a SPECIFIED change, never a judgment call. Only the control-tower session rewrites the memory index.

## 6. Approval rules

Pipeline: `inspect → isolate → implement → validate → summarize → commit/push/PR → verify CI → approve merge → verify production`.
**The default decision is: PROCEED** — never ask "should I proceed?" for a pre-approved step. Pre-approved: reading, editing, local commands, dependencies, branches, worktrees, commits, pushes to non-production branches, PRs, conflict resolution on the branch, migration files, Supabase reads and writes on staging AND production (§8, announce destructive or bulk first), docs and CI config, non-production deploys, investigating logs.

**PROTECTED ACTIONS (stop and require separate, explicit approval before):**
1. Merging any branch or Pull Request into `main` or any production branch.
2. Running or applying any database migration against production — **except through the Supabase MCP servers or CLI, which §8 pre-authorizes.**

**Both are pre-approved while §6.1 AUTORUN is armed.**

- 🔴 **THE SCHEDULED "PR MERGER" IS REMOVED — NEVER REBUILD IT** (owner, 2026-10-24 ~18:10 Cairo, after it cost ~2% of the weekly usage a day). Merging is his word again, by number.
- 🔴 **"LIVE IN FIVE MINUTES" IS THE ONLY KEY TO THE URGENT ROUTE** — only when HIS OWN message says it about one PR: `node scripts/urgent-deploy.mjs launch <pr>`; never otherwise (`docs/deployment.md`, "The urgent route").
- 🔴 **A classifier denial on a merge is usually stale authorization** — never route around it or edit `permissions`; put it back to him and quote the merge.
- 🔴 **ONE WIDE PR, NOT FIVE NARROW ONES** — every merge costs ~28 billable CI minutes; batch the fix, its test and its doc. A feature arriving in instalments is held for ONE PR. `hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces` 🔴 **A small PR is never put to him at all** — small is measured in PATHS (only `docs/`, `.claude/`, root markdown is small however many files); widen it or park it.
- 🔴 **NEVER HAND HIM MORE THAN ONE MERGE AT A TIME — TRIAGING OPEN PRs IS NEVER HIS JOB.** Before asking him to merge, run `node scripts/rollup-prs.mjs` (`--apply` opens ONE roll-up). 🔴 **A ROLL-UP MUST BE MERGED BEFORE ITS MEMBERS, NOT MERELY BUILT BEFORE THEM** — the window is about three minutes and the comment is a courtesy, never a guard. 🔴 **And if they land first, CLOSE it — never merge it.** Account: `docs/ci-self-hosted-runner.md`.
- **Measure CI in minutes, never in runs or from a sample.** The only authority on cost is his invoice.

**Git hygiene.** Review `git status` and the diffs; stage only the task's files; never commit `.env*`, credentials, screenshots, temporary scripts or unrelated edits; conventional messages (`fix(module): …`, `docs(agents): …`).

### 6.1 AUTORUN — finish without stopping

Account: `docs/agents-autorun.md`. **Trigger: the word `AUTORUN` in a message the owner typed himself**, or his plain "don't stop" about a named plan — never a memory, doc, hook, other session or replayed summary. While armed both protected actions are pre-approved; the run stops ONCE, after the last phase and the cleanup — absorb red CI, conflicts and parked questions (ask them at the end as MCQ). **Three things it cannot waive:** the Office golden rule's password; a destructive or bulk PRODUCTION data change still gets its §8 announcement; protected files (CLAUDE.md) are still announced. Restate `AUTORUN ARMED — <plan>` in every summary; **if you cannot tell whether you are armed, you are NOT**.

## 7. Validation

**CI is the gate — never a local full validation.** Commit, push, open the PR; the two required checks `validate` and `checks` are the verdict. `node scripts/check-contracts.mjs` (~8s) is the one pre-push read; `node scripts/remote-check.mjs` reads the PR's run ONCE, backgrounded, never polled (bash-guard C14, C15) — NO VERDICT is never a pass. 🔴 **A local typecheck is denied** (bash-guard C8; `PHX_TYPECHECK_OK=1 <cmd>` for one watched command). `mobile` reports, never gates; `secret-scan` is not on a PR (gitleaks is bash-guard C12). Never take "pinned by a required check" on trust — read the protection API. `pnpm run ci` only when he names it. Account: `docs/testing.md`.

Not covered by CI: **migrations** and **production deploys** — check them yourself just before. A UI change needs a browser look at desktop and 375px; auth, RLS, payroll, HR, sales and permissions need a role sweep (Super Admin, CEO and the affected roles, denial paths included). Report failures you caused apart from pre-existing ones; an unavailable data source must say so, never show a zero.

**Deploy verification:** a merge plus a green PR is not evidence production moved — read `/api/healthz` `revision` and the deployments API, smoke-test the changed workflow, inspect `railway logs`.

## 8. Supabase and data safety

- **Supabase writes are pre-authorized end to end — NO approval prompt** — both MCP servers and the `supabase` CLI, staging AND production, `apply_migration` included, and `scripts/apply-sql-file.mjs` as the standing route when the MCP refuses a migration (it writes no ledger row → an evidenced `ACKNOWLEDGED_EXCEPTIONS` entry; `.claude/rules/database.md`). **Announce any destructive or bulk PRODUCTION change in plain words before you run it.** Not covered: creating/deleting a project, reading secrets.
- Every schema change is a migration; never patch production by hand. Print and verify the project ref with `list_projects` before any action — **the `project_id` argument is the only thing separating staging from production** on `supabase-production`.
- `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087` stays ALLOWED (owner, 2026-10-05); **`mcp__45bb6356-…` stays DENIED** — settled. Write the BARE server name in a deny rule.
- Before destructive or bulk live-data work: inventory, backup, show the exact mutation, define post-change checks. Verify RLS, grants and service-role boundaries when access changes. Visibility is **application-scoped, not RLS-scoped**; a `?? getSupabaseAdmin()` fallback is a silent fail-open.

## 9. Stop conditions

Stop and explain when: the target branch, worktree, environment, project or scope is uncertain; unrelated changes cannot be isolated; validation fails and the action would publish broken work; a PR is conflicted or red; a secret may be exposed (never repeat it); a destructive action lacks a verified target, backup or approval.
