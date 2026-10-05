# Phoenix Workforce — Agent Rules

Operating rules for every AI agent and automation tool in this repository. Codebase reference
(layout, auth, API conventions, cron, env) lives in [docs/architecture.md](docs/architecture.md);
daily commands and the protected-file gate live in [CLAUDE.md](CLAUDE.md). Higher-priority platform
or system instructions take precedence. When instructions conflict or scope is unclear, stop before
the risky action and explain the conflict plainly.

**This file auto-loads in full on every request, so it holds hooks only** — a hook is the rule plus
the one detail needed to obey it, never the evidence. **Adding a rule? If it belongs to ONE module,
it goes in that module's memory (`.claude/rules/<module>.md`, §2.2) — only a rule true everywhere
goes here — and the account goes in `docs/`, never here.** A section is the half that regrows and nothing gates
one: measure it before you add to it (`docs/memory-index-budget.md`). 🔴 **A session-level trap now
goes in [docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md), under its
cluster — never back into §2.1**, which the 2026-09-12 trim reduced to a pointer and a slug roster;
writing one here re-charges every request for it and the hook will never deliver it.

**The accounts are read on demand — before working in an area, search its account for the hook's
wording.** Payroll, sales/closing, recruitment, CRM, exports → `docs/agents-owner-rules.md`. Deploy,
cron, production data → `docs/agents-production-hooks.md`, `docs/environment.md`. Worktrees and
machine limits → `docs/agents-worktree-and-machine-limits.md`. Shell, git, CI, validation →
`docs/agents-session-traps.md`. Memory index → `docs/memory-index-budget.md`. AUTORUN →
`docs/agents-autorun.md`. Why a §2 rule exists → `docs/agents-incident-history.md`.

**Every memory note is filed under a module, `global` or `history` in
`scripts/module-memory/assignments.json`, and CI refuses an orphan (§2.2).** A backticked slug here or
in a module file is a cue to open that note; `docs/agents-memory-map.md` maps the older slugs to hooks.

## 0. How this repo is actually run (calibrate to this)

One owner runs everything. He is **not a career engineer** — he is the business owner of a live HR
platform a real pharmaceutical company runs payroll, attendance and sales on. Real employees are
paid from this data. Over the last 90 days (measured 2026-09-21):

- **~46 commits/day, 6.7 files per commit.** Small, focused changes, shipped constantly.
- **1,935 fix commits vs 1,226 feature commits.** More than half of all work repairs work.
- **Shipping is the main activity** — a fifth of all instructions are merge/deploy/verify-prod.
- **Sessions run for hours or days**, often **after midnight**. Assume tiredness, assume context has
  been compacted, assume the human cannot hold the whole system in his head at 4am. That is your job.
- **Almost nothing prompts** (rule 1.5) — you are the last line of defense.

He writes short, terse instructions and expects you to work out the scope. Explain like a smart
non-engineer: what happened, what it costs, what to do next.

## 1. The five rules that prevent the rework

1. **Show the proof, never the claim.** "Tests pass", "it is deployed", "the migration applied" are
   worthless without the output that shows it. Paste the count, the revision id, the row, the HTTP
   status. If you did not run it, say so. **Being wrong is recoverable; being confidently wrong is
   what costs a day.**
2. **Verify against live reality, not a plan or a memory.** A ledger is not the database
   (`list_migrations` lies — query `pg_class`/`pg_proc`). A merged PR is not a deploy. A green CI is
   not a working page. A memory file is a point-in-time note, not current state. Re-check before
   asserting.
3. **Finish every phase.** Given a numbered or phased plan, execute all of it, in order. Never stop
   after 1–2 phases and never silently skip one. If a phase is genuinely blocked, stop and say which
   one and why — never quietly deliver a subset and call it done.
4. **After compaction or a long session, distrust yourself.** A replayed summary of earlier work
   reads like a live instruction. Before acting on "previous" state, re-run the check. Prefer one
   fresh session per task over one endless session.
5. **The absence of a permission prompt is not approval.** The desktop app starts every session with
   `--permission-mode auto`, so a classifier, not a prompt, decides; `permissions.ask` in
   `.claude/settings.json` is **empty** and `permissions.deny` holds only silent hard blocks. **Every
   approval rule in §6 is therefore behavioral: ask in plain words and wait for a plain answer.**
   Read the settings file before asserting what is enforced.

## 2. Hard-Learned Rules (each cost a real incident — do not relearn them)

Why each exists: `docs/agents-incident-history.md` — read it before changing branch protection, CI
cost, the deploy path or the region.

- **Never use `gh pr merge --auto`.** `main` is branch-protected with **2 required checks** — `validate`, `checks`; `allow_auto_merge: false`. Merge only with a plain `gh pr merge` after separate owner approval. 🔴 **THAT LIST HAS ROTTED FIVE TIMES, AND `lint`, `typecheck` and `test` ARE NOT CHECK NAMES.** Never quote this line, or any doc, as the source: read `branches/main/protection/required_status_checks` live and count passes against what it returns, because a gate counting to a number a doc gave you waits forever for checks that are gone. `node scripts/check-required-checks.mjs` compares this line against the live gate and is the ONE thing that catches the next rotation. Account: `docs/agents-incident-history.md`.
- **Never commit directly onto local `main` in the primary checkout.** The push is then rejected (`enforce_admins: true`), and the commit strands on the one checkout every parallel session shares — where another session’s `git reset` destroys it. Branch first. If you already committed: `git branch <name> <sha>` then `git reset --keep origin/main` (**not** `--hard`, which would also wipe other sessions’ uncommitted work), then open a PR. Cost a real recovery on 2026-09-12 (#3728).
- **Do NOT run `gh pr update-branch` reflexively** — "require branches up to date" is OFF (`strict: false`) and each run costs ~16 Actions minutes. Run it **only when the change depends on something newly on `main`**.
- **`gh pr update-branch` acts on the SERVER** — `git fetch` and `git merge --ff-only origin/<branch>` before your next push; CI re-runs on the new head.
- **A merge to `main` SHIPS TO PRODUCTION as soon as that commit's CI is green** (Railway, full traffic, no smoke test). **Never merge what you would not have serving employees within minutes**; confirm with `/api/healthz` `revision`.
- 🔴 **THE DEPLOY IS GATED ON CI, AND THE GATE FAILS BY NOT SHIPPING — SILENTLY.** Railway "Wait for CI" holds the deploy until every check suite on the pushed commit finishes; **red, cancelled, or still queued = no deploy, and after 2 hours Railway SKIPS it with nothing turning red.** So a merge that never shipped now looks exactly like one that did — read `/api/healthz` `revision`, never the merge. Any workflow on that commit can hold it, not just `ci.yml` (a failed `staging-migrate` blocks production), and `railway variables --set` **bypasses the gate entirely**. Never remove `push: main` from `ci.yml` to save minutes — that silently un-gates production. 🔴 **And never cancel a stuck `main` run and walk away** — a commit whose ONLY run is `cancelled` is exactly this failure (it happened on `88f86ee57`, saved only by a dispatch 5 seconds later): fix the cause and `gh run rerun <id>` on the push run, or produce a succeeding run on that same SHA. Account: `docs/deployment.md`, "The deploy gate".
- **There is a staging application**, wired to the staging Supabase project — §3.
- **A hand-run typecheck must start cold:** `tsc --incremental false`.
- **Never foreground-watch a long pipeline.** Background it and check at batched checkpoints.
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), never the cookie flow — it logs the real user out.
- **Merged-branch checks must be squash-aware:** `gh pr list --head <branch> --state merged`, never `git branch --merged` — 🔴 **but that asks about a NAME, so a REUSED name returns the OLD merged PR while yours is still open**: before deleting a branch ask for the PR by NUMBER and check its files are byte-identical on `main`. `a-reused-branch-name-finds-the-old-merged-pr`
- **A regression test counts only if you break the fix and see its own headline assertion fire.**
- **`list_migrations` reports the ledger, not reality** — query `pg_class`/`pg_proc`.
- **Commit, push and open the PR WITHOUT asking; ALWAYS ask before merge** (owner rule, 2026-09-16 — supersedes the old auto-git ban). Branch first, stage only the task's files, never `--auto`.

### 2.1 Session-level traps

**The traps themselves moved to [docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md) — they are DELIVERED, not dropped.** `.claude/hooks/trap-injector.mjs` is a PreToolUse hook that reads what the session is about to run and injects the matching cluster once per session: the git traps when you touch git, the Supabase traps when you touch Supabase. Thirteen clusters — **Shell and tooling · Git · CI and PRs · Migrations · Database, grants and RLS · Probing, attributing and reporting production · Validation · Memory and this index · Parallel sessions · Worktrees · Next.js runtime · Browser and dev-auth · Machine ceiling.** That is 30 KB this file no longer charges to every request.

🔴 **The hook FAILS OPEN and SILENT, so its silence proves nothing** — it says the same thing when no cluster matched and when it never ran at all. **If you cannot see a trap block for the kind of work you are doing, open the clusters file and read the matching one yourself**, before the first command of that kind. A session started before the hook merged does not have it.

**Each line there is a cue, not the fact.** The account of every one is in [docs/agents-session-traps.md](docs/agents-session-traps.md); which memory backs which hook is in [docs/agents-memory-map.md](docs/agents-memory-map.md).

**Memory slugs that this section was the only pointer for.** `scripts/memory-index-reachability.mjs` scans **this file** and matches the **backticked** form, so these stay here whatever happens to the prose above — deleting one orphans that memory unless `MEMORY.md` also links it. They are a reachability roster, not a reading list; the hook each belongs to travels with its cluster.

`tz-africa-cairo-silently-returns-utc-in-msys` · `looking-at-a-generated-workbook-two-ways-that-lie` · `a-manual-scheduled-task-run-leaves-no-trace` · `main-is-not-the-primary-checkout` · `a-missing-table-answers-pgrst205-not-42p01` · `attribution-rollup-fingerprint-ignores-the-sales-data` · `offer-chain-was-live-in-the-registry-with-a-hole-past-approval` · `ats-candidate-children-one-has-no-fk-and-one-is-a-view` · `cv-extraction-reads-governorate-but-never-applies-it` · `the-medical-rep-cv-schema-reads-12-fields-universal-reads-38` · `a-cv-import-overwrote-a-candidates-whole-identity` · `the-email-import-allowlist-holds-an-inbox-not-a-sender` · `cv-file-is-in-ats-files-not-cv-external-url` · `census-client-errors-by-stack-not-message` · `typecheck-incremental-false-green` · `the-test-suite-runs-with-production-credentials-and-app-env-production` · `tailwind-merge-strips-custom-named-font-sizes` · `bilingual-bodies-need-direction-per-line-not-per-block` · `ireports360-timestamps-cairo-local-mislabeled-utc` · `verify-the-emitted-artifact-never-the-source` · `at-slash-lib-shadows-src-lib-via-tsconfig-paths` · `gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded` · `collapsed-browser-pane-reads-zero` · `agent-isolation-remote-ran-locally-in-a-worktree` · `automode-allow-cannot-authorize-editing-the-permission-config` · `claude-project-dir-is-the-sessions-own-worktree` · `supabase-access-and-prod-token-are-one-token` · `git-branch-d-is-not-a-safety-gate-after-a-squash-merge` · `a-squash-merge-makes-a-stacked-branch-rebuild-not-merge` · `claude-code-effort-max-got-slow-xhigh-is-the-balance` · `slowness-audits-compare-before-and-after` · `verifying-a-new-workbook-builder-takes-three-layers` · `two-session-stores-two-retention-keys` · `a-worktree-husk-is-pinned-by-the-session-not-its-cwd` · `regen-readslivedata-flag-matches-a-comment-not-a-call` · `apply-sql-file-default-pooler-host-is-wrong-for-production` · `railway-services-are-born-in-sfo-and-volumes-are-region-pinned` · `a-green-test-run-carries-no-type-signal-at-all` · `a-mismatch-query-hides-the-row-that-matches` · `grepping-a-wrapped-report-turns-an-explanation-into-a-verdict` · `pg-stat-statements-times-precisely-and-attributes-never` · `never-hand-roll-a-rule-the-repo-already-implements` · `mains-required-checks-are-four-not-six-checks-carries-the-suite` · `a-field-that-does-not-exist-is-a-silently-dead-branch` · `the-four-shapes-a-stale-citation-sweep-misreads` · `a-ledger-version-never-matches-the-file` · `the-small-pr-merge-guard-and-the-classifier-deadlock` · `a-no-commit-merge-probe-actually-merges-in-the-shared-primary`

### 2.2 Memory — module memory and the index

**Each line is a cue.** How it works, why, and the proof it loads: `docs/module-memory.md`.

- 🔴 **A MODULE-MEMORY LIMIT IS NEVER PUT TO THE OWNER — IT IS THE SESSION'S TO FIX AND SHIP** (owner, 2026-10-03, after a session put "the Phoenix CRM notes file is full at 4,478 of 4,500 characters, so your next CRM ruling cannot be recorded until it's split" into his input box: *"didn't you tell me no session will mention memory issue again"*). Module memory exists so he never thinks about memory capacity again, and that promise covers the plumbing too. A pointer over its margin, a module file near its cap, an orphan note, a dead glob, a stale generated block, an inbox that will not settle: **split it, file it, rebuild it, and ship it inside the PR you are already opening** — never as a question, never in a `Next step:` line, never as a sentence in a summary, and **never as a request to free space in `MEMORY.md`**, which is not trimmed any more. Every one of those limits already fails the required `validate` job, so the SESSION is told and he is not. Account: `docs/module-memory.md`, "Limits".
- 🔒 **MODULE MEMORY HOLDS EACH MODULE'S RULES AND NOTES — `.claude/rules/<module>.md`, loaded BY CLAUDE CODE the moment a session reads a file of that module** (owner, 2026-10-02 — it ended the trim-and-forget cycle; proven: no file read → not loaded, another module's file → not loaded, this module's file → loaded). None of it costs a startup byte. Work that opens no file (a question, SQL, a shell `cat`) gets it from `.claude/hooks/module-memory-injector.mjs`, which matches the prompt, the command and table names. 🔴 **About to change a module and its memory has not appeared? Open `.claude/rules/<module>.md` yourself** — the hook fails open and silent.
- 🔒 **ROUTE A NEW RULE BY WHERE IT APPLIES — never into this file by default.** One module → that module's `## Rules` section, in the PR that teaches it; a changed rule is an EDITED line, never a second one that contradicts it. True everywhere → here. A session trap → `docs/agents-session-traps-clusters.md`. The account always goes to `docs/`. **Never delete a rule to make room.**
- **A new memory note still lands in the laptop index (`MEMORY.md`, under `## Inbox`), so every session sees it at once; the fold (`node scripts/module-memory/fold.mjs --apply`) files each note under its module in ONE PR and the inbox empties once that merges.** The note's `description` becomes its line in the module file — write it as the cue, and correct a wrong note at its `description` first. 🔴 **IT RUNS THREE TIMES A DAY — 09:00, 15:00 and 21:00 Cairo, not weekly** (owner, 2026-10-03). A run with nothing new opens NO PR, and only one fold PR is ever open at once, so the cadence costs no extra CI — it only shortens the wait before a note reaches its module.
- 🔴 **`tests/module-memory.test.ts` runs `scripts/module-memory/build.mjs --check` in the required `validate` job and REFUSES an orphan note, a dead glob, a module file over its cap, a stale generated block, or a rules file with no `paths:`** (that one would load at startup for everyone). Never hand-edit a generated block — edit `scripts/module-memory/modules.mjs` or `assignments.json` and run `node scripts/module-memory/build.mjs`.
- **`MEMORY.md` still auto-loads and is still SILENTLY truncated at 25 KB / 200 lines — it now carries only what is true everywhere plus the inbox.** Never move a module fact back into it "to make sure it is seen": that is the cycle module memory replaced.

**The modules** — generated from `scripts/module-memory/modules.mjs`; each file's `paths:` holds every glob.

<!-- module-memory:directory:begin — generated by scripts/module-memory/build.mjs -->
| Module | Loads when a session touches |
| --- | --- |
| `payroll` — Payroll, salaries and deductions | `src/lib/{payroll,automated-payroll,deductions,daily-deductions,finance,reconciliation,calculator}/**` and 4 more |
| `sales-closing` — Monthly Closing, the Office and El Qema money rules, the Business Review | `src/lib/sales/*` and 6 more |
| `sales-imports` — Source of Sales — distributor imports, customer mapping and rollups | `src/lib/sales/{normalizer,master-data,master-map,ai}/**` and 5 more |
| `sales-attribution` — Attribution, achievement, targets and sales territory | `src/lib/sales/territory/**` and 5 more |
| `weekly-sales` — Weekly sales and stock | `src/lib/sales/weekly/**` and 3 more |
| `direct-orders` — Direct orders | `src/lib/direct-orders/**` and 4 more |
| `incentives` — Incentives and targets payout | `src/lib/incentives/**` and 2 more |
| `phoenix-crm` — Phoenix CRM (the reps' own CRM) | `src/lib/phoenix-crm/**` and 4 more |
| `phoenix-crm-approvals` — Phoenix CRM — lists, validation, plans and approvals | `src/lib/phoenix-crm/{adoption-rules,approval-nudge-rules,customer-list-grouping,entry-rules,list-request-rules,list-row-facts,list-sheet-hours,list-template-rules,monthly-plan-rules,offplan-day,pharmacy-call-rules,plan-edit-rules,plan-review-rules,plan-rules,unplanned-rules,validate-next}.ts` and 4 more |
| `phoenix-crm-boards` — Phoenix CRM — the silent detectors, the touch trail and the SFE's boards | `src/lib/phoenix-crm/{behaviour-integrity,duplicate-photos,location-integrity,refused-readings-rules,touch-trail,touch-trail-reader}.ts` and 7 more |
| `crm` — Field CRM analytics (iReports360) — visits, KPIs, reps lists and plans | `src/lib/{crm,crm-integrity,customer-360,customer-identity,double-visit-analytics,visits-report,field-activity,weekly-planning}/**` and 10 more |
| `marketing` — Marketing requests, venues, pharmacies and ROI | `src/lib/{marketing-requests,venues,pharmacy-master,pharmacy-search,customer-pharmacy-mapping,verified-captures,market-awareness,sales-marketing-intelligence,evidence}/**` and 4 more |
| `recruitment` — Recruitment, CVs and offers | `src/lib/{recruitment,cv,offers,whatsapp-inbox,mailbox-monitor,zoom}/**` and 4 more |
| `hiring-documents` — Hiring documents, contracts and company papers | `src/lib/{hiring-pack,hiring-documents,contracts,business-cards,spotlight,pdf,export}/**` and 3 more |
| `employees` — Employees and the HR lifecycle | `src/lib/{employees,employee-lifecycle,employee-360,hr,resignations,retention,retention-risk,lifecycle-risk,new-hire-mailbox}/**` and 4 more |
| `probation` — Probation and employee milestones | `src/lib/{probation,milestones}/**` and 4 more |
| `time-off` — Vacations, attendance and calendars | `src/lib/{vacation,attendance,excuses,early-birds,hr-calendar,private-calendar,calendar}/**` and 5 more |
| `expenses` — Expenses and outstation trips | `src/lib/outstation/**` and 4 more |
| `org` — Organogram, territory and geography | `src/lib/{org,workforce,field-workforce-compliance,territory-management,geo,geocoding,google-maps}/**` and 4 more |
| `portal` — Employee portal, dashboards and command centres | `src/lib/{employee-portal,navigation,overview,dashboard,action-center,needs-you,ceo,company-activity-report,support-requests,workspace,reports,activity}/**` and 5 more |
| `notifications` — Email, notifications and messaging | `src/lib/{email,email-templates,notifications,communication,internal-messages,distribution-lists,sato-email,personal-mailbox,mailbox-offboarding,conversations,whatsapp-videos}/**` and 5 more |
| `turbify` — Turbify mailbox console — the shared browser driver | `src/lib/turbify/**` and 3 more |
| `turbify-provisioning` — Turbify provisioning — creating a mailbox, its invitation and its app password | `src/lib/new-hire-mailbox/**` and 3 more |
| `coaching` — Coaching, training and visual aids | `src/lib/{coaching,visual-aids}/**` and 4 more |
| `report-it` — Report It (pharmacovigilance — patient data) | `src/lib/report-it/**` and 3 more |
| `approvals` — Approvals and workflow | `src/lib/{approvals-hub,workflow-control,workflow-registry,approvals}/**` and 4 more |
| `devices` — Devices and tablet management (Headwind MDM) | `src/lib/devices/**` and 4 more |
| `platform` — Platform — auth, security, cron, data access and shared UI | `src/lib/{auth,security,platform,cron-control,background-jobs,observability,error-monitor,share-links,share,http,imports,uploads,ai,validation,qr,operations,synthetic-journeys,admin,format,i18n,ui,utils}/**` and 8 more |
| `database` — Database, migrations and Supabase | `supabase/**` and 2 more |
| `engineering` — Engineering — CI, tests, scripts and deploys | `.github/**` and 7 more |
| `git-worktrees` — Git, worktrees and the shared primary checkout | `scripts/{new-session,sync-worktree-env,repo-doctor}*` and 1 more |
| `sessions` — Sessions — the Claude Code harness, this laptop and the memory system | `.claude/hooks/**` and 4 more |
<!-- module-memory:directory:end -->

### 2.3 Production and approval hooks

**Each line is the rule, not the evidence.** Account: `docs/agents-production-hooks.md`. **The
module-specific production hooks are module memory now** — Railway and the deploy queue in
`engineering`, cron and secrets in `platform`, each data hook with the module that owns the table.

- **A deploy applies NO migrations, and auto-deploy can silently SKIP** — read `/api/healthz` `revision`.
- 🔴 **Production has NO PITR — 7 daily backups are the whole recovery story.** Say so before any bulk or destructive change, and **never restore a daily backup in place.**

**Which environment the code thinks it is in**

- **A LOCAL run writes PRODUCTION but skips every email, and the local Resend key CANNOT send** — send from production with `railway run`.
- **STAGING cannot rehearse a PRODUCTION shape.**
- **`isProductionRuntime()` reads `APP_ENV || VERCEL_ENV || NODE_ENV`, and a production build sets `NODE_ENV=production` on staging** — `APP_ENV` must stay set there (fixed).
- **Staging email is safe only because `PHOENIX_EMAIL_FORCE_TESTING` is set explicitly — one variable, nothing behind it.**
- **The `APP_ENV`/cron-secret hole is CLOSED — do not re-chase it**, but treat `!isProductionRuntime()` as an auth fallback with suspicion.

## 3. Stable Environment Facts

Lookup facts, not behaviour. **The full list — Railway services and region, domains, the production
scheduler and the five Actions crons, the outbox-drain check, CI secrets, environment meanings — is
in `docs/environment.md` "Stable environment facts"; read it before touching deploy, staging, cron,
domains, the region or a Supabase ref.**

- Production: `https://phoenix-hr.satopharma.com`, Railway service `phoenix-people-workforce`, environment **`production`**, region `europe-west4-drams3a` — **it must stay in Europe.** Confirm the service's source branch before assuming a merge ships (§2.3).
- Staging: `https://phoenix-people-workforce-staging.up.railway.app`, same project, on the staging Supabase project.
- **GCP and Vercel are DEAD** — never deploy to or verify against them.
- **The production scheduler is `cron-job.org`** — check it before telling the owner anything is stalled; a green outbox cron proves nothing, read `drainHealth`. **The drain alarm is deliberately never email — do not "fix" that back.**
- **`.env.local` points at PRODUCTION Supabase.** `pnpm run dev` mutates production data.
- **Supabase project refs — the complete list `list_projects` returns.**

  | Ref | Name | Region | Org | What it is |
  | --- | --- | --- | --- | --- |
  | `ozucdzovmcqvepbozvqf` | Phoenix HR | eu-central-1 | `rovnkzmhokgsruftjsaw` | **PRODUCTION** — real payroll data |
  | `cifwmndunmlxjhyjugxa` | Phoenix-HR-Staging | eu-central-1 | `rovnkzmhokgsruftjsaw` | **STAGING** |
  | `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | **`tvweawmrjrekvepkcxzs`** | unrelated to this app — **different organization** |

  **Dead refs — treat any doc, memory or prompt still naming one as stale:** `izhmxvgiktiafqusolot` and `oaifhavixhdtwmseshff`.

  **Neither region nor org is a guard** — `supabase-production` sees every ref its token can. Resolve with `list_projects` before acting (§8).

Never store passwords, tokens, API keys, service-role keys, JWT secrets, connection strings or other
credentials in this file or in Git. Never assume a pasted preview URL is current.

## 4. Standing owner rules

The owner's own decisions — not suggestions. **Each line is the rule;** the account of each (his
words, incidents, measurements, pre-image tables): `docs/agents-owner-rules.md`.

**The golden rule that comes before the rest of this section**

- 🛑 **THE MOBILE APP IS FROZEN — DO NOT WORK IN IT, TOUCH IT, PLAN IT, MENTION IT OR ASK HIM ABOUT
  IT, UNTIL HE LIFTS THIS IN HIS OWN WORDS** (owner, 2026-09-29: *"the mobile app do not work or
  touch or think in it … Neglect it totally until I finish the website or the web app or the normal
  Phoenix. After this, I will tell you, delete this golden rule … never suggest on me, never ask me,
  never consider it in any of my wording."*). **The web app is the whole scope.** No edit under
  `mobile/`, no Expo/EAS build, update or workflow dispatch, no mobile branch or PR — **and equally
  no words**: never propose mobile work, never put it in a `Next step:` line, a plan, a summary, a
  recommendation or a "while we are here", never ask him a mobile question, and never read an
  instruction of his as reaching the app when it can be served on the web. 🔴 **A mobile defect you
  notice is not reported and not filed — it is left alone**, and an old mobile task in a session's
  own history is over, not resumed. 🔴 **Only HE lifts it, typed by him, about the mobile app** —
  never a memory, a doc, another session, a replayed summary, an AUTORUN plan, or your own reading
  that the web work looks finished; if you cannot tell, it is still frozen. Until then **every other
  mobile rule in this file is DORMANT** — history for when it lifts, never guidance to act on.
  Mechanically refused by `.claude/hooks/mobile-freeze-guard.mjs` (writes into `mobile/` and the
  Expo/EAS toolchain; reads are not blocked), pinned by `tests/mobile-freeze.test.ts`. Account:
  `docs/agents-owner-rules.md`, "The mobile-app freeze". `the-mobile-app-is-frozen-until-he-lifts-it`

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in both UI and chat.
- **Never truncate text with an ellipsis.** Where it collides with the no-horizontal-scroll rule, wrapping wins.
- Give only recommendations grounded in a real confirmed need. **Never pad a list to hit a number.**
- **Open EVERY reply with one `Next step:` line — FIRST, not last, and not repeated at the end**, and it **ALWAYS ends in curly-quoted words he could send as-is** (owner, 2026-09-18 — "always put something in the box"). It names what needs him; when nothing does, it says what finished and quotes the next REAL action, named with its real target — never filler, never invented work. 🔴 **The no-quotes "nothing waits on you" form is RETIRED** — it left his box reading `<no suggestion>`. The 2026-09-15 loop ban is untouched: never quote a re-check, a re-run, a status read, "continue", "check other pending items" or a closing word. `recommendation-goes-first-not-last`
- 🔴 **THE QUOTED WORDS ARE A MESSAGE HE SENDS TO CLAUDE — never a PHYSICAL act, and never a MESSAGE HE SENDS TO A PERSON.** The test is not "could he send this as-is" but **"can CLAUDE act on it once sent"**: a click, a file pick, a factory reset, a QR scan, a power-on — and `tell HR to …` — all fail it, because the box offers them as ghost text and they arrive as an instruction to do the one thing Claude cannot. Four physical ones on 2026-09-28, three `tell HR` ones on 2026-09-29 in a session that had this rule loaded. **When the bottleneck is his hands or his phone, say so in the PROSE with the exact path and put the draft there in full; quote something Claude can act on** — the instruction that FOLLOWS, a merge, or a build Claude fires. Account: `docs/agents-owner-rules.md`, "The Next step box holds words CLAUDE can act on". `never-put-his-physical-actions-in-the-next-step-box`

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead.**
- **Ask when the answer changes the outcome; decide when it does not.**
- **Ask business-fact questions IN CHAT as multiple choice, never in prose** — short options, one idea each, recommended first; read his typed "Other" answers closely. An XLSX with dropdowns is only for long per-item lists. Never guess to avoid asking. `ask-business-questions-as-in-chat-multiple-choice`
- Take ownership. Automate the work rather than returning a checklist he has to execute.

**How to build**

- **Before building new UI, match the sibling pages' exact design identity.** Never invent a one-off look.
- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.** Use `<table className="w-full table-fixed">` with a `<colgroup>`; fit by MERGING columns, never shrinking type — `overflow-x-auto` over a `min-width` IS the bug. Measure `scrollWidth > clientWidth` over `main` at desktop and 375px; `shrink-0` makes an inner `flex-wrap` inert. 🔴 **A table that can sit in a GRID CELL switches on its own width, never the viewport's** — `@container` + `@min-[Npx]`, not `lg:block`: a 1280px viewport holds a 452px half-column and a 918px full-width band at once, so a viewport breakpoint cannot see the narrow one (measured 2026-10-03, 18 clipped cells on `/sales/rankings`). `never-horizontal-scroll-always-mobile-and-desktop-friendly`
- Admin shell: **desktop shows full tables/dashboards, mobile gets cards.**
- 🔒 **THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.** `tokens.css`'s `--phx-radius: 4px` is the bug; measure computed `border-radius`, since `globals.css`'s sweep is not coverage. Restoring premium polish from history re-rounds corners — take the depth only. Pinned by `tests/admin-shell-palette-scope.test.ts` and `tests/hiring-pack-paper-editor.test.ts`.
- 🔒 **THE DOCUMENT IDENTITY — every company document wears `SATO-DIS-2026-01 v1.0`** (Sato Pharma's, never the app's); "put it in the system template" is STANDING. Logo palette `#0A527D`/`#0A6BA6`/`#1482C2`. 🔴 **THE INK RULE — no filled areas** except the 6% zebra row; government forms are exempt; on paper the mark is `sato-pharma-logo-on-light.png`. Module: `src/lib/hiring-pack/house-identity.ts`. `the-house-document-identity-standard`
- **One production deployment per task.** Bundle all phases into one PR.
- ⏸️ **DORMANT under the mobile-app freeze at the top of §4** — do not act on this, do not raise it.
  🔴 **MANAGED GOOGLE PLAY REACHES NO REP TABLET — the store `.aab` is NOT how the mobile app ships, and the upload is DROPPED** (owner, 2026-09-28: *"drop the managed play upload since it cannot reach the fleet"*). Measured the same day: `enterprises/LC017auv4o` has **0 enrolled devices** and the package answers **404**, because the tablets are enrolled in the company's own **Headwind MDM**, which installs an **APK it hosts** and links to a configuration — and they carry no Google account by design. **The fleet artifact is `eas.json`'s `mdm` profile** (arm64 APK, `production` channel), a dispatch choice on the Mobile build workflow since #4652. Never read a green store build as fleet cover, and never re-propose the Play upload as the way to ship to reps. `managed-play-cannot-reach-the-rep-tablets`
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.

**Product rules that must not be "fixed" back** — **each one lives in its module's memory**
(§2.2) and loads with that module. Kept here: the two dormant rules the mobile-app freeze pins in this file, and the rule the owner
ordered locked EVERYWHERE, because every module's numbers depend on it:

- ⏸️ **DORMANT under the mobile-app freeze at the top of §4** — the one live half is the web side:
  `phoenix_app_shell=1` defaults FALSE and must stay, because removing it strips the WEB portal's
  chrome for every browser user. 🔒 **THE MOBILE APP IS A SHELL OVER THE WEB PORTAL — NEVER REBUILD A PORTAL SCREEN NATIVELY** (owner, 2026-09-29). Home and every module render the production `/employee-portals` pages in a WebView; **native is login, Phoenix CRM and Profile, nothing else**. 🔴 **The `phoenix_app_shell=1` gate defaults FALSE and must stay** — removing it strips the web portal's chrome for every browser user. Pinned by `tests/native-web-handoff.test.ts`. Account: `docs/agents-owner-rules.md`, "The mobile app is a shell". `the-mobile-app-is-a-shell-over-the-web-portal`
- 🔒 **THE MONTHLY-CLOSING SOURCE-OF-TRUTH GOLDEN RULE — the Monthly Closing module is the ONE source of truth for every SALES *and* every TARGET figure, system-wide** (owner, 2026-08-13; **targets made explicit and the rule ordered locked everywhere 2026-09-27**: "your source of truth to calculate any sales any targets is the monthclosing module, lock this golden rule everywhere in system"). Every surface — Sales vs Target, overviews, portal landings, command centres, incentive achievement, Employee 360, **Business Review** — computes BOTH the sales and the target it divides by through the closing engine, and must equal the **PUBLISHED** closing for that person and month; a page that re-derives either half from its own query, its own table or its own period is the bug, never a variant. Weekly Sales, Marketing ROI and the **Business Review pack** are the carve-outs — never invent a fourth. 🔴 **THE BUSINESS REVIEW READS THE LIVE ENGINE, NOT THE PUBLISHED SNAPSHOT** (owner, 2026-09-28, asked directly and answered *"use the live one"*). It is a REVIEW, not a payout record, and the two diverge for reasons correct on BOTH sides — a direct order counts in the month Finance books it, and the engine resolves geography as of the period — so the snapshot would understate real money and freeze a stale geography. **Never "fix" the Business Review back onto the snapshot, never republish a month to make them agree, and never acknowledge the drift to silence it.** A partial-window or per-page TARGET that inflates an achievement is the same defect on the denominator side. Account — the measured drift, line by line: `docs/agents-owner-rules.md`, "The Business Review reads live". `sos-monthly-closing-is-the-only-sales-truth`


## 5. Session, worktree, and parallel-work safety

Before editing, run `git status`, `git branch --show-current`, `git log -1 --oneline`,
`git worktree list`. Account: `docs/agents-worktree-and-machine-limits.md`.

- Use one working tree per active session. **Never two interactive sessions in one folder** — the SessionStart lock warning stops you editing that folder. 🔴 **It is no longer stop-and-ask when the holder is PROVABLY LIVE** (lock refreshed inside 15 minutes, i.e. 3 heartbeats): the hook then tells you to isolate with `node scripts/new-session.mjs <task>` and **carry on without stopping** — never ask him to confirm what the lock already proves. Measured 2026-09-21: the old single warning fired on **170 of 198** sessions here and spent a turn on that question every time. Only an OLDER non-stale lock (15 min – 2 h) may belong to a session that crashed mid-task, and that one still asks. Both halves keep every commit/push/edit ban. (A live session refreshes its lock on every Bash, PowerShell, Edit or Write call; a crashed one's self-expires 2 hours after its last refresh, and that AGE is the ONLY staleness test — the lock's `pid` is the hook's own parent shell, so EVERY lock names a dead PID.) Pinned by `tests/session-lock-staleness-is-age.test.ts` in the required `checks` job.
- Start new work from the latest `origin/main` on a focused `codex/<task>` branch unless told otherwise.
- Never run `git clone`, `git init`, or anything that recreates the primary repository's `.git`.
- Never discard, overwrite, clean, reset or revert changes you did not create. Treat unexpected changes as the owner's work; classify and preserve a dirty tree.
- **Never delete a `.xlsx` or `.pdf` file.** Scan a folder before removing it; move any not identical to a tracked copy into `xlsx/` at the repo root.
- **Start a session with `node scripts/new-session.mjs <task>`** (fetch, `_wt-<task>` on `codex/<task>`, `node_modules` junction, env files; refuses below 6 GB free commit). `--status`, `--repair`, `--from <ref>`. A bare `git worktree add` has no `.env.local` and no `node_modules`.
- **A sibling `_wt-<task>` is a NEW project to Claude Code** — `node scripts/sync-worktree-env.mjs` copies `.claude/settings.local.json` and points `autoMemoryDirectory` at the primary's memory.
- **A worktree session WRITING into the primary checkout is now denied mechanically** - `.claude/hooks/primary-write-guard.mjs`, PreToolUse on Write/Edit/NotebookEdit, live 2026-09-17. It refuses an edit into the primary or another session's worktree, never a READ; before it, that write SUCCEEDED silently and stranded the change in the shared primary. **A `_wt-<task>` this session made with `new-session.mjs` is its OWN** - edit it with Edit/Write, never a Bash write. `PHX_PRIMARY_GUARD_OFF=1` stands it down; a session in the primary never sees it.
- **Never `pnpm install`, `pnpm run` or `pnpm exec` inside a worktree** — they purge the `node_modules` junction, and `pnpm exec` fails silent-shaped. Invoke `node scripts/…`; dev server: `node scripts/dev-server.mjs --port 3000` — it caps the server's heap at 4 GB where a raw `next dev` takes half of RAM, and refuses a second server; `bash-guard.mjs` C7 DENIES a raw `next dev` everywhere (2026-09-21). **Mechanical since 2026-09-16:** `bash-guard.mjs` C6 DENIES every pnpm form here and names the node equivalent — a deny because `Bash(pnpm run *)` and `Bash(pnpm exec *)` auto-approve it, so no prompt was ever coming.
- 🔴 **A BROWSER LOOK AT PUSHED CODE GOES ON THE HETZNER PREVIEW BOX, NOT A LOCAL DEV SERVER** — a local `next dev` costs ~4 GB and half the CPU (measured 2026-09-30), the box costs this laptop an ssh tunnel. The owner runs `phx-preview [branch]`; a session ASKS HIM rather than starting a local server. **It serves PUSHED branches only** — read `git status --porcelain` and `git rev-list --count origin/<branch>..HEAD` FIRST and say whether the preview would show the work; a local server stays right only for uncommitted edits, a dev-auth role sweep, or local files, and is stopped as soon as the look is done. Account: `docs/agents-worktree-and-machine-limits.md`, "A browser look at pushed code goes on the Hetzner preview box".
- **A dev server a SESSION opened dies with it** (`dev-server-reaper.mjs`, that one only); one you started yourself is nobody's child — **stop it by PORT, not by task:** `Get-NetTCPConnection -LocalPort 3000 -State Listen`, then `Stop-Process -Id <OwningProcess> -Force`. Only a curl of `000` proves the port is free. 🔴 **"NEVER CLOSE THE DEV UNTIL I TELL U" is now SCOPED, not repealed** (owner, 2026-09-28 — *"allow me to stop dev servers I start myself"*): one YOUR session started is yours to stop; one HE or another session started still waits for his word. **`TaskStop` does NOT free the memory** — it kills the wrapper and leaves the child holding the port. Check the PID's start time matches when you started it, and read free RAM TWICE: a compile spiked 3,056 MB → 134 MB and recovered to 1,675 MB by itself. `i-may-stop-a-dev-server-i-started-myself`
- In-repo worktree folders must start with `_wt-` (or sit under `.codex-worktrees/` or `.claude/worktrees/`). Locked `.claude/worktrees/` belong to live sessions — never remove them.
- **Remove worktrees with `node scripts/new-session.mjs --remove <task>`, only after approval** — its gate asks the merged PR, because **a squash-merged branch legitimately holds commits `main` does not.**
- **`git worktree remove` leaves a HUSK nothing in git can see** — run `pnpm run repo:doctor` after any removal; `--fix` deletes only zero-file husks.
- **`repo:doctor` lists memory files with no index line** (`--deep` for all) and writes nothing except `--snapshot-xlsx` (outside the repo) — **but by default it pages the PRODUCTION GoTrue admin API**; `--no-auth` skips that.
- **`xlsx/` is gitignored and its hourly backup has holes — never call a sheet covered without checking.** Covered: untracked sheets at the top of the PRIMARY's `xlsx/`, copied to `F:\PHX backup\05-data-files`, with a Telegram alert on a failed or killed run. Not: subfolders, worktree `xlsx/` folders, hours the laptop is off (caught up on wake, never alerted), or a disk failure (same SSD).
- **Worktree payload slows TREE-WALKING TOOL CALLS and nothing else — it is NOT why the machine or the app feels slow.** A recursive `grep`, `dir /s` or naive watcher pays ~346k path entries here (10–40 s), while `.gitignore`-honouring tools never see one: retire merged worktrees and clear husks for your own command speed, **never on machine-performance grounds**. Corrected 2026-09-17 — disk sat 99.6–99.9% idle with a 0.00 queue while the box was slow, and the desktop app's own UI outweighs every session on CPU. **FREE RAM is what binds, and fewer open SESSIONS is the only lever — his call alone.** Do not tune `tsconfig`/`eslint`.

**Machine limits.** RAM is 16 GB. One dev server at a time, ever; one typecheck/build at a time
locally — parallel validation belongs to CI. 🔴 **FREE RAM is what binds, not the commit charge** — the
pagefile is FIXED at 64 GB (commit limit ~80 GB), so commit headroom stays GREEN while physical RAM
runs out. Read free RAM live, never a remembered figure or the session count. 🔴 **NOTHING GATES A
HEAVY JOB ANY MORE — the heavy-job gate and its queue were RETIRED on 2026-09-17 at the owner's
instruction, and are never to be rebuilt** (`docs/agents-worktree-and-machine-limits.md`); a
typecheck, build or dev server is now YOUR judgement from live free RAM. 🔴 **`mem-watchdog.ps1`
reaps NODE JOBS, and a dev server only as a RUNAWAY (8 GB+ of commit) or after 25 minutes with NO
WORK** (owner's choice, 2026-09-21) — one in use under 8 GB is never touched. Under **1,800 MB** it
reaps a typecheck, build or test run, under **500 MB** any node job.

**THE ROUTING GOLDEN RULE (owner-confirmed 2026-09-25) — route by what a task NEEDS, not what it
is, and default to cloud.** The 4am mechanical test: needs a **browser look, a dev-auth role sweep,
or local creds/files** → local worktree; is a **decision, a merge/deploy, or the database** → main
checkout; **everything else → cloud.** Cloud sessions never compete for this box's RAM, so
defaulting to cloud IS the anti-freeze lever, not a compromise — the freeze bites on the number of
*local* sessions, never on the work itself.

🔴 **A CLOUD SESSION IS PHOENIX-BLIND BY DEFAULT — it gets the git repo and your prompt, and NOTHING
ELSE.** The two layers that make a LOCAL session wake up knowing Phoenix — the global standing rules
(`~/.claude/CLAUDE.md`) and the ENTIRE auto-memory (`MEMORY.md` + every memory file) — live on the
laptop, are not in git, and never reach cloud. Cloud knows only the committed files (`AGENTS.md`, the
project `CLAUDE.md`, `docs/`, the code) plus what the task prompt spells out. **So never send cloud a
judgment call or an open question that leans on tribal knowledge — send it a SPECIFIED change whose
context is in the repo or the prompt. A generic answer from cloud is this gap, not a broken session.**
Account: `docs/agents-worktree-and-machine-limits.md`.

Route work by tier:

| Tier | Where | Use for |
| --- | --- | --- |
| **A — Cloud session** *(the default)* | Isolated cloud clone, ends in a PR | A SPECIFIED, self-contained change — feature, logic fix, refactor, a test, docs — whose context is in the repo or the prompt, plus anything heavy (build, typecheck, full test). NOT judgment calls or memory-dependent questions. Sonnet by default. |
| **B — Local worktree** (max 2–3 woken) | Sibling `_wt-<task>` | ONLY a task needing a browser look, a dev-auth role sweep, or local creds/files. |
| **C — Main checkout** (exactly one — the control tower) | primary repo folder | Decisions, merge/deploy, DB (Supabase) work, deployed-env verification, worktree triage, the memory index. Never feature edits. |

Only the control-tower session rewrites the memory index; others may append memory files but never
reorganize it. Because cloud is repo-plus-prompt only, a cloud task's prompt carries every fact it
needs — never assume it can see local state, memory or the standing rules.

## 6. Approval rules

Pipeline: `inspect → isolate → implement → validate → summarize → commit/push/PR
→ verify CI → approve merge → verify production`.

**The default decision is: PROCEED.**

Complete every pre-approved step automatically and ask permission ONLY at one of the two protected
actions below. Do NOT repeatedly ask for confirmation ("Should I proceed?") for pre-approved actions.
If a task requires no protected action, complete it without asking.

**PRE-APPROVED ACTIONS (proceed automatically):**
- Reading, searching and auditing the codebase
- Editing or creating files, refactoring, fixing bugs
- Running local commands, tests, lint, type checks, builds and validation
- Installing or updating dependencies when required for the task
- Creating branches, worktrees, commits, and pushing to non-production branches
- Creating, updating or reviewing Pull Requests (merging requires approval)
- Resolving merge conflicts on the working branch
- Creating database migration files, testing migrations locally or in non-production
- Supabase reads and writes on staging AND production, `apply_migration` included — §8's grant (announce a destructive or bulk production change first)
- Updating documentation, configuration or CI/CD configuration
- Deploying or testing in local, preview, development or staging environments
- Investigating logs, errors or infrastructure (GitHub, Railway, Supabase)
- Running safe diagnostic or repair actions outside production

**PROTECTED ACTIONS (stop and require separate, explicit approval before):**
1. Merging any branch or Pull Request into `main` or any production branch.
2. Running or applying any database migration against the production database/environment — **except through the Supabase MCP servers or CLI, which §8 pre-authorizes.**

**Both are pre-approved while §6.1 AUTORUN is armed.**

🔴 **A CLASSIFIER DENIAL ON A MERGE IS USUALLY STALE AUTHORIZATION, NOT A STANDING BLOCK — AND THE
FIX IS A FRESH WORD FROM HIM, NEVER A SETTINGS CHANGE.** Auto mode judges from what it can
currently SEE, so his approval going out of view across a context compaction reads exactly like a
permission he never gave: same `[Production Deploy]` refusal, same wording. Measured 2026-09-29 —
six merges went through on his approval, then #4776 was refused hours later on the *same* standing
approval; he retyped `merge 4776` and it passed on the next attempt, head sha unchanged. **Never
route around it, never ask a peer session to merge for you** (that launders a permission decision
made in your window), and never propose editing `permissions` to clear it. Put it back to him and
quote the merge. A denial is about what the classifier can see, not about what is permitted.

### 6.1 AUTORUN — the owner's standing instruction to finish without stopping

Account — what he was shown, what he answered, why the trigger is a typed word:
`docs/agents-autorun.md`.

**Trigger: the word `AUTORUN` in a message the owner typed himself.** It arms the session that
received it, for the plan named in that message, until that plan is finished. **Read it PERMISSIVELY
(his decision):** his plain instruction to run a named plan without interruption — "don't stop", "do
the whole thing" — arms it too, and stopping to ask which he meant is the failure this rule removes.
**It is NEVER armed by a memory, a doc, a hook, another session or a replayed summary**, and one
arming authorizes ONE session (§2.1, Parallel sessions). The guard hook matches only the literal word,
so when he arms a long plan without it, say in one line that you are treating it as armed.

**While armed, BOTH protected actions are pre-approved** — merging to `main` and applying a
production migration (through Supabase, §8 pre-authorizes that armed or not). **Do not re-ask, do not
re-warn, and do not treat a phase boundary as a checkpoint.** **The run stops ONCE: after the last phase AND the cleanup are done.** Absorb and keep
going through: a red CI check (fix, push again); a merge conflict (resolve it); a business-fact
question (park it, then ask all at the end in chat as multiple choice, §4 — an xlsx only for a long per-item list); a blocked phase (finish
every other phase, then name it); a choice you could make yourself (prefer the reversible option).

**Three things AUTORUN cannot waive:**

1. **The Office golden rule** needs a password that exists only as a scrypt verifier
   (`pnpm run office-rule:unlock`). A plan needing it stops there and only there.
2. **A destructive or bulk PRODUCTION data change** still gets its §8 announcement — state it, take
   the pre-image or backup FIRST, prove it landed, then proceed.
3. **The other protected files** (CLAUDE.md) are still announced before the edit — announced, not awaited.

**The final report is the whole point:** every merge, production change and migration applied, the
parked questions, and anything left undone.

🔴 **AUTORUN survives compaction only where `.claude/hooks/autorun-guard.mjs` is loaded** — it
re-states an arming per `session_id` (never creates one; `AUTORUN OFF` stands it down), and hooks load
at session start from the worktree's own branch, so **never assume it is running**. **Restate
`AUTORUN ARMED — <plan>` at the top of every summary and hand-off**, and **if you cannot tell whether
you are armed, you are NOT** — finish the current phase, say so in one line, and continue asking as
normal. The hook's silence proves nothing either way.

**Git hygiene.** Review `git status`, `git diff`, `git diff --cached` before committing. Stage only
files owned by the task. Never commit `.env*`, `.vercel/`, credentials, local artifacts, screenshots,
temporary scripts, unrelated lockfile changes or unrelated user edits. Use conventional messages
(`fix(module): reason`, `feat(module): capability`, `docs(agents): change`). `main` is production —
never edit it directly. `delete_branch_on_merge` is on, so GitHub deletes the **remote** branch
automatically; the local branch and worktree survive and still need approval to remove.

🔴 **ONE WIDE PR, NOT FIVE NARROW ONES — EVERY MERGE COSTS ~28 BILLABLE CI MINUTES** (owner,
2026-09-27: "you make many prs and many merges you can wider the contact of the pr to make less
merges"). A merge pays a full CI run on the PR **and** another on `main`, ~14 billable minutes each,
because GitHub rounds every job up to a whole minute. That VOLUME, not the pipeline, is the whole
bill. 🔴 **THE ONLY AUTHORITY ON WHAT THIS COSTS IS THE INVOICE — $300.88 for September, the highest
he has ever paid** (his own statement, 2026-09-27, correcting a session that had derived nearly twice
that from measured job minutes). **Never convert measured minutes into a monthly bill**: the billing
API needs a token scope no session here has, so a session cannot check its own arithmetic. Measure
minutes, report minutes, anchor money to the invoice he can read. **So batch related work into ONE
branch and ONE PR**: finish the whole task — the fix, its test, its doc, the follow-ups you can
already see — before opening it, and push fixups in fewer, larger commits (concurrency cancels
superseded PR runs, so two pushes a minute apart bill twice and verify once). Splitting is still
right when the parts need SEPARATE approval (a migration, a locked file, a protected rule) or when
one part is urgent and the rest is not — never merely because the change feels tidier in pieces.
🔴 **AND A FEATURE ARRIVING IN INSTALMENTS IS STILL ONE FEATURE — HOLD THE PARTS** (owner,
2026-09-29: *"batch the next feature into one PR, not six"*, after one shipped as six PRs in a
morning because he asked for the surfaces one at a time). When the next instruction is plainly the
same mechanism on another surface, a follow-up named in the same breath, or a pin of a ruling just
given, **hold it and open ONE PR when the feature is whole**, saying in one line that you are holding
so he can override. Widening a PR his approval already sits on is allowed — say so plainly and let
him re-confirm; it is no longer a reason to open a second.
`hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces`
🔴 **NEVER HAND HIM MORE THAN ONE MERGE AT A TIME — TRIAGING OPEN PRs IS NEVER HIS JOB, AND
CONSOLIDATING THEM IS YOURS** (owner, 2026-09-30: *"i till now donot know what to do with small open
prs"*). He does nothing: he never decides which to merge, which to close, or what counts as small.
**Before asking him to merge anything, run `node scripts/rollup-prs.mjs`** — it groups every open PR
whose file set is DISJOINT from the others into one branch, reports which are SUPERSEDED and which
must stay SEPARATE (a migration, a protected file, a frozen path), and `--apply` opens ONE PR. It
never merges; `--settle` closes only a PR already byte-identical on `main`. 🔴 **A ROLL-UP'S MEMBERS
ARE NOW REFUSED MECHANICALLY — `bash-guard.mjs` C13 denies `gh pr merge` of any PR an open roll-up's
body lists**, because **a comment on a PR is not enforcement**: the ~3-minute window was lost at
least four times with this rule loaded. It reads the roll-up's own body, so nothing extra is marked;
the roll-up itself and an unreadable body both pass, and `PHX_MERGE_OK=1` stands it down. Pinned by
`tests/rollup-member-guard.test.ts`.
🔴 **`--apply` WAITS for the members' required checks and builds ONLY from the ones that finish GREEN** —
up to 25 min (`--wait <minutes>` or `PHX_ROLLUP_WAIT_MINUTES`; `--no-wait` takes whatever is green now).
**A quiet run is working, not hung.** A member that is red, unfinished at the deadline, pushed mid-wait,
or carrying checks older than its own head commit is LEFT OUT, not refused — it rolls up next run. **An
unknown flag is REFUSED**, because an ignored one runs an older worktree's behaviour while reporting
success. Account: the script's own header.
🔴 **THE WINDOW IS ABOUT THREE MINUTES, SO A ROLL-UP MUST BE MERGED BEFORE ITS MEMBERS, NOT MERELY
BUILT BEFORE THEM** (measured 2026-09-30). One opened at 13:16 lost both members by 13:18:55 — the
first 90 seconds after being commented on — which with the morning's #4814 makes **three members lost
in one day: the comment is a courtesy, never a guard.** So build it the moment `rollup-prs.mjs` names
one and put it to him in the SAME turn; never hold it until the members go green, which is what
`--apply`'s own 25-minute checks wait already covers. 🔴 **And if they land first, CLOSE it — never
merge it:** it then replaces no merges, its files are byte-identical on `main` (the `carried`
verdict), and merging is an empty squash paying a full `main` run. Account:
`docs/ci-self-hosted-runner.md`, "A roll-up must be merged before its members".
🔴 **MEASURE IN MINUTES, NEVER IN RUNS, AND NEVER FROM A SAMPLE — both lie**, and two sampled dollar
figures were published and corrected before this was re-measured from every run of the month.
`ci.yml` is ~89% of the bill, so nothing outside it is worth touching, and `main` already runs
exactly once per commit. **`main`'s ~40% is NOT reclaimable — it is the production deploy gate**
(§2), so the only lever left that costs no safety is the self-hosted runner. 🔴 **The Actions runs
API caps at 1,000 rows and truncates the OLDEST silently** — a wide query returning *exactly* 1,000
is truncated data wearing the shape of a complete month; count the rows and disbelieve that number.
Account for all three — the measured arc, why the run COUNT lies, and why 54 billable minutes went on
one 5-file PR: `docs/ci-self-hosted-runner.md`, "Why the volume is what it is", "Where the money
actually is" and "A feature arriving in instalments is still ONE feature".

## 7. Validation

**CI is the gate. Do not run a local full validation.**

`check:harden` and the `ask-before-validation` hook are retired at the owner's instruction. Do not
reintroduce them or invent a replacement — no "quick subset" of lint + typecheck before pushing, no
`pnpm run ci` as a pre-push ritual. 🔴 **The one standing step is NOT local: `node scripts/remote-check.mjs
test` on the committed sha before EVERY push that opens or updates a PR** (owner, 2026-10-04; `all` when
the change adds a route, a file or a closed-union member) — `docs/testing.md`, "Before every push".
Its typecheck half runs by itself: `.claude/hooks/push-typecheck-guard.mjs` refuses a push whose
typecheck FAILED on the box — commit and push in separate commands (`docs/ci-self-hosted-runner.md`,
"The remote typecheck before every push"). **Then push the branch and let the PR's checks answer.** The two
**required** checks — `validate` (the `check:*` contracts, **the unit suite**, and on non-PR events
the build and login smoke) and `checks` (lint, `next typegen`, typecheck) — run on the PR head commit
and block the merge if either is red. 🔴 **THE UNIT SUITE MOVED BACK INTO `validate` ON 2026-09-30, FOR
WALL CLOCK, AND IT IS STILL INSIDE A REQUIRED CHECK.** `checks` ran typecheck (111s) then the suite
(97s) in SERIES on one runner — 80% of a PR's ~260s wait — while `validate` sat on ~37s of work since
the build was gated off pull requests. Beside the typecheck instead of behind it, a PR is ~163s.
🔴 **It is NOT a job called `test`, and must not become one:** that is a retired check name, and a job
protection does not require reads on a PR exactly like one that gates (#3950). `lint`, `typecheck` and
`test` still do not exist as check names. A doc naming any of them as a job or a check name is stale —
but **a pinned test now belongs in `validate`, not `checks`**.
🔴 **`mobile` REPORTS, NEVER GATES; `secret-scan` IS NOT ON A PR AT ALL** (read live 2026-10-01).
`mobile` is the Expo typecheck, skipped unless `mobile/` changed, and red never blocks a merge.
`security-scan.yml` lost its `pull_request` trigger 2026-09-29 — gitleaks moved into
`bash-guard.mjs` **C12**, which refuses the push — so its absence is CORRECT, never a coverage gap:
never wait for it or dispatch one. Account: `docs/testing.md`.
🔴 **NEVER TAKE "PINNED BY A REQUIRED CHECK" ON TRUST, AND NEVER COUNT TO A NUMBER A DOC GAVE YOU —
read the protection API.** Both halves cost real incidents: the 2026-09-17 split left `test` OUT of
protection until 09-18, so every locked-rule test went red without blocking a merge; and the
2026-09-27 rename left 19 places in this repo telling sessions to wait for six checks that can never
all report again. 🔴 **The 2026-09-29 drop was DELIBERATE, not rot** — `mobile` and `secret-scan`
left protection minutes before #4800 took them off the pull request, and the two HAD to move
together: **a required check whose job no longer reports leaves every PR on "Expected — waiting for
status" and nothing can ever merge.** So demoting a check and un-wiring its job are ONE change in
one window, never two — either half alone is a permanent block or the 2026-09-17 shape. Only this
doc lagged, and `node scripts/check-required-checks.mjs` is what catches that lag. `pnpm run ci` is
opt-in: run it **only when the owner names it**.

🔴 **A LOCAL TYPECHECK IS NOW DENIED MECHANICALLY — `bash-guard.mjs` C8, live 2026-09-25 — in every
spelling**, including `pnpm/npm/yarn run typecheck`, `npx`/`pnpm exec tsc --noEmit`,
`node …/typescript/bin/tsc`, `lib/tsc.js`, `.bin/tsc`, a quoted node path, and any script whose body
resolves to one. It had to become a hook because the rule above did not hold on its own: a reaped
typecheck prints **nothing** and exits non-zero, which a session cannot tell from a typo, so it tries
another spelling — **23 of 23 node jobs the memory watchdog killed in its surviving log window were a
typecheck**, six of them inside ten minutes. `PHX_TYPECHECK_OK=1 <cmd>` (`$env:PHX_TYPECHECK_OK=1;`
in PowerShell) stands it down for one command you will sit and watch. Pinned by
`tests/local-typecheck-guard.test.ts`.

Two things are NOT covered by a PR's CI and still need a check immediately before the action:
**migrations** and **production deploys**. Verifying a UI change in the browser is not validation at
all — reload and look.

| Change type | Minimum validation | Who runs it |
| --- | --- | --- |
| Docs or repo instructions only | Review diff, formatting, links, secret exposure | You, by reading |
| Narrow TypeScript/JavaScript change | Lint, typecheck, targeted tests | CI, on the PR |
| Shared runtime, app/API route, server component, env or deployment behavior | Lint, typecheck, tests, build | CI, on the PR |
| UI workflow | Relevant code checks plus browser verification at desktop and mobile sizes | CI for the code; **you** for the browser |
| Migration, view, function, RPC, grant or policy | Migration checks, SQL review, target confirmation, schema/security review, staging verification after approval | **You, before the migration** — CI never sees this |
| Auth, RLS, payroll, HR lifecycle, sales, permissions, executive reporting | Full checks, role-based tests, failure-state checks, explicit risk review | CI for the code; **you** for the role sweep and the risk review |

Prefer repository scripts over improvised commands. Never present a known-broken change as ready.
Report failures your change caused separately from pre-existing ones. When a data source is
unavailable, verify the UI says so rather than showing a misleading zero.

**Role-based testing.** For permission-sensitive work, test the affected roles including denial
paths. Sales: Super Admin, CEO, National Sales Manager, Regional Manager, District Manager.
Coaching: Super Admin, CEO, SFE Manager, Training Manager, and Medical Rep when employee review is
affected. HR: Super Admin, CEO, HR Advisory, HR Operations, and Employee when portal behavior is
affected. Do not claim role safety from code inspection alone when real role testing is possible.

**Deploy verification.** Production is Railway auto-deploy on push to `main`, **gated on that
commit's Actions check suites** (Wait for CI — see §2). So a green CI is now a precondition of the
deploy rather than a report on it, and the new failure mode is a deploy that never happened: confirm a
deploy through `gh api repos/Gawish-1997/phoenix-people-workforce/deployments` or `railway status`, and
what serves traffic via `/api/healthz` `revision` — **a merge plus a green PR is not evidence
production moved.** Smoke-test on the live staging app (§3) before a risky
production deploy when there is time. After a runtime-impacting production deploy, verify the public
domain, smoke-test the changed workflow and inspect `railway logs`. When a page fails, capture the
visible error, browser console, network/API response, deployment logs and database/RLS evidence
before proposing a fix.

## 8. Supabase and data safety

- **Supabase writes are pre-authorized end to end — NO approval prompt** (the owner's `autoMode` grant deliberately removes the §6 gate for Supabase). It covers the `supabase-staging` and `supabase-production` MCP servers and the `supabase` CLI (incl. `db push`), on staging AND production, reads and writes alike — `execute_sql` mutations, `apply_migration`, bulk and destructive SQL. The one standing condition: **announce any destructive or bulk PRODUCTION change in plain words before you run it, and give the owner a chance to stop it.** (It does NOT cover creating/deleting a project or reading secrets.)
- All schema changes must be migration-based, repeatable, reviewable and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref, resolving it with `list_projects` rather than trusting a ref pasted in a prompt or copied from an older doc.
- `supabase-production` can see **every project its token reaches.** **Its name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.** `supabase-staging` is pinned to staging.
- Any UUID-named Supabase tool (a claude.ai account connector) stays deny-listed by default; `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087` is the one exception: the owner allowed it on 2026-10-05 and had its project-level deny removed. It stays allowed — no Phoenix project setting may re-deny it, and a blocked call to it is a bug, not a decision. **Write the BARE server name in a deny rule** — a `__*` suffix matches nothing.
- **OWNER DECISION: `mcp__45bb6356-…` stays DENIED** — settled; do not re-allow it, propose it or chase a blocked call as a bug.
- Before destructive or bulk live-data work, inventory the target, create or verify a backup, show the exact mutation, and define post-change counts or checks.
- Verify RLS, grants, RPC authorization, service-role boundaries and browser-role exposure whenever permissions or data access change. Service-role credentials stay server-only.
- Visibility in this app is **application-scoped, not RLS-scoped** — most code paths use the service-role client. A `?? getSupabaseAdmin()` fallback is a silent fail-open.

## 9. Stop conditions

Stop before delivery or mutation and explain the blocker when:

- The target branch, worktree, environment, project or requested scope is uncertain.
- Unrelated changes cannot be isolated safely.
- Validation fails and the proposed action would publish known-broken work.
- A PR is conflicted, required checks are failing, or the preview is not the expected deployment.
- A secret may have been exposed. Do not repeat it; recommend revocation and replacement.
- A destructive action lacks a verified target, backup, recovery path or explicit approval.
