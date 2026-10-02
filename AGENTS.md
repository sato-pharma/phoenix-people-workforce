# Phoenix Workforce — Agent Rules

Operating rules for every AI agent and automation tool in this repository. Codebase reference
(layout, auth, API conventions, cron, env) lives in [docs/architecture.md](docs/architecture.md);
daily commands and the protected-file gate live in [CLAUDE.md](CLAUDE.md). Higher-priority platform
or system instructions take precedence. When instructions conflict or scope is unclear, stop before
the risky action and explain the conflict plainly.

**This file auto-loads in full on every request, so it holds hooks only** — a hook is the rule plus
the one detail needed to obey it, never the evidence. **Adding a rule? Put the hook here and the
account in `docs/` — never the account here.** A section is the half that regrows and nothing gates
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

**Memory slugs live in `docs/agents-memory-map.md`, not here — except the ones that map marks
`(inline — load-bearing)`.** `scripts/memory-index-reachability.mjs` scans `AGENTS.md` only and
matches the **backticked** form, so a slug removed from here orphans that memory **unless `MEMORY.md`
also links it**. **Re-run the classifier before removing any slug**
(`node scripts/memory-index-reachability.mjs`; `pnpm run repo:doctor` for the live scan).

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

### 2.2 The memory index

**Each line is a cue.** Why, every trim pass and the budget arithmetic:
`docs/memory-index-budget.md`.

- **`MEMORY.md` is the ONLY auto-loaded memory file, and the loader truncates it at 24,400 bytes — SILENTLY.**
- **The budget is 22,000 bytes.** `node scripts/repo-doctor.mjs` prints the bytes to free; `.claude/hooks/memory-index-guard.mjs` repeats it at SessionStart.
- 🔒 **THE DISPLACEMENT RULE — never add an index line without freeing at least as many bytes in the same edit.**
- 🔒 **IGNORE the "compact it to under 17.1KB" message** — it is arithmetically impossible; landing under the cliff with headroom is a SUCCESS.
- **Route by KIND of fact, never by topic** — agent trap → §2.1, production or approval hook → §2.3, owner product rule → §4.
- **Never delete a hook to make room, and correct the memory FILE (its `description` decides recall) before the hook.**
- **A line earns its place only if** a session would act WRONGLY without it, it is durable (never a count, status or date), and it is not derivable in one step.
- **A relocation spanning git and `~/.claude/` finishes BOTH halves or neither, in that order — and the condition is PRESENT IN THE CHECKOUT YOU TRIM FROM, not merged.** `node scripts/memory-index-reachability.mjs` must read **0 reachable from neither in THAT folder** before you trim; check which slugs appear only in a section before cutting it. 🔴 **From a WORKTREE that script CANNOT do it — it resolves its root from `--git-common-dir` and scans the PRIMARY's `AGENTS.md`**, so a slug you added there is invisible and one you deleted still reads `ok`. Run it from the primary, or grep the file you actually edited. `memory-reachability-classifier-reads-the-primarys-agents-md`
- **Reporting may union `origin/main:AGENTS.md` (repo-doctor does); trimming must stay local-only.**
- **No required check can gate any of this** — `MEMORY.md` lives outside the repository, so the displacement rule is behavioural.

### 2.3 Production and approval hooks

**Each line is the rule, not the evidence.** Account: `docs/agents-production-hooks.md`.

**Railway deploys**

- **A deploy applies NO migrations, and auto-deploy can silently SKIP** — read `/api/healthz` `revision`.
- 🔴 **A FAILED, CANCELLED OR STILL-QUEUED CHECK SUITE ON THE COMMIT MAKES RAILWAY MARK THE PRODUCTION DEPLOY `SKIPPED` WITHIN MINUTES, AND RE-RUNNING IT GREEN DOES NOT RESURRECT IT.** 🔴 **A green `ci.yml` does not rule it out — read `commits/<sha>/check-suites`, never only the CI run:** a scheduled workflow and **Dependabot** both attach a suite here, and a Dependabot failure is cured by an override in `pnpm-workspace.yaml`, never a rerun. 🔴 **The tell is RED WHILE RAILWAY IS STILL WAITING**, not merely red on the commit. 🔴 **The four third-party suites — `sentry`, `claude`, `vercel`, `railway-app` — sit `queued` FOREVER on every commit and never hold the gate**; never chase them. **GitHub only ever says `inactive`, the same word as a healthy superseded deploy** — the tell is an `inactive` that was NEVER `success`; `verify-shipped.mjs` prints `WITHHELD` and names the bad suite. 🔴 **Recovery is to do NOTHING — the next green merge carries it forward**: never `railway redeploy`, never re-merge. 🔴 **A withheld deploy whose every suite is GREEN was SUPERSEDED, not refused**, so classify by the suites before calling anything a refusal. 🔴 **And judge on the STATE HISTORY, never the last state** — `/deployments/<id>/statuses` is NEWEST FIRST, so `| last` hands you the OLDEST while looking final: ask `--jq 'any(.[].state; . == "success")'`. The rows LAG the live domain, so settle with `git merge-base --is-ancestor`. Account: `docs/agents-production-hooks.md`. `a-red-main-ci-makes-railway-skip-the-deploy-for-good` · `a-superseded-deploy-reached-success-a-withheld-one-never-did`
- 🔴 **A SUCCEEDED DEPLOY CAN STILL LEAVE THE DOMAIN ROUTING TO NOTHING, BOTH ENVIRONMENTS AT ONCE.** Railway's edge answers `{"code":404,"message":"Application not found"}` — the ROUTER with no service for that Host, never the app erroring — so `/api/healthz` has no `revision`, `verify-shipped.mjs` prints **CANNOT TELL** (exit 5), and a wait loop continuing only on `QUEUED` stops there and reports a fine deploy as FAILED. No §2.3 tell sees it; it self-healed in under two minutes (2026-09-30). **Do NOTHING — never `railway redeploy`, never re-merge, never `source connect`** — and classify on whether a `revision` comes back AT ALL. Account: `docs/agents-production-hooks.md`.
- **Two merges inside a minute look ROLLED BACK when they are only QUEUED.** Read deployment STATES, never timestamps; settle with `git merge-base --is-ancestor <your merge> <live revision>`. Do NOT re-merge or `railway redeploy`.
- 🔴 **THE QUEUE REALLY DOES PROMOTE AN OLDER BUILD — MEASURED, NOT HYPOTHETICAL — SO AFTER A COLUMN DROP THE RULE IN THE MIGRATIONS CLUSTER APPLIES TO THE DEPLOY QUEUE AND NOT ONLY TO THE DASHBOARD.** 2026-09-29: live went `5f1f40305` (8th on `main`) → `85f5a7db7` (**4th**) → `3c576e7d8` (9th), settled at each, 14 rapid reads returning one revision each time, so it is a slower build finishing later — **not** a replica split. Harmless alone; an outage once a dropped column is still named by an older build. **The rule, the two-deploy sequence and the seconds-long recovery are in `docs/agents-session-traps-clusters.md` (Migrations) — read there, not here.** Account of this measurement: `docs/agents-production-hooks.md`.
- 🔴 **A RAILWAY VOLUME DELETE REPORTS SUCCESS AND DELETES NOTHING, AND AN ORPHAN'S PURGE DATE APPEARS ON A DELAY — SO "no schedule" NEVER MEANS "never expires".** `volumeDelete` returns clean and `railway volume delete --yes` prints `Volume "<name>" deleted` while the volume is still listed; the GraphQL `Volume` type has no `deletedAt` field, so a query keeps returning it as though the delete never happened. **`railway volume list` is the ONLY readout that tells the truth — it prints `Deletes on:`.** 🔴 **Read it TWICE, hours apart, before concluding anything** — one orphan read no schedule at all and carried a purge date a couple of hours later, and an earlier version of this very hook read that gap as "it will sit there until someone removes it". **So never read a delete confirmation as evidence, never hand-delete an orphan on the strength of an absent date, and never delete a volume holding data you did not create — that is the owner's dashboard click.** Account: `docs/agents-production-hooks.md`.
- 🔴 **A MERGE CAN CREATE NO CI RUN AND NO DEPLOYMENT AT ALL — NOT `SKIPPED`, NOT `inactive`, NOTHING TO FIND.** Distinct from the red/queued SKIP above: there is no row anywhere to attribute, and **the commit's checks read GREEN**, because `workflow_run` and scheduled runs attach to whatever `main` HEAD is when they fire. **Ask for `ci.yml` BY PATH and count it, with the FULL 40-char sha** — the runs API answers `0` silently for a short sha, which reads exactly like the fault — and use a neighbouring commit as a control. **Recovery is to do NOTHING: the next merge carries it** (measured 2026-09-28, `d3bd33679` live 24 min later inside `4a4dd8d3d`); there is no run to rerun, nothing is held, and `railway redeploy`/re-merge remain forbidden. Account: `docs/deployment.md`, "The five failure modes", mode 5.
- **`railway variables --stdin` stores a BOM** inside the value.
- **`railway ssh` JOINS argv and lands as ROOT.**
- 🔴 **`railway service source connect` is NOT environment-scoped — `--environment staging` REPOINTED PRODUCTION.** Never use it to preview; staging a branch needs a separate service.
- 🔴 **`railway service scale <region>=1` ADDS a region, it does not MOVE one** — it answered `EU West (1) · sfo (1) — 2 replicas`, i.e. two live copies of an MDM server writing one database (2026-09-28, Headwind EU cut-over). **Pass the old region `=0` in the SAME command**, and read the region map the call prints back before believing a move happened. A new service is created in `sfo`, so every one needs this explicitly (§3, "it must stay in Europe").

**Cron and secrets**

- **A PARTIAL `CRON_SECRET` rotation leaves TWO fingerprints, and Healthchecks `up` is not proof.** The past 401s are resolved: **rotate NOTHING.** 🔴 **`len` is 64, NOT the 71 this line claimed until 2026-09-30** — measured, and it authorizes (8 cron calls, all 200, zero 401). A stale figure read against a live one is what makes the rotation this rule forbids look necessary.
- **`CRON_SECRET` flows GitHub → Railway** (`sync-railway-production-secrets.yml` overwrites Railway) — **rotate GitHub first.** The 4 OFF iReports360 jobs are DELIBERATE.
- **The cron-job.org REST API allows 100 requests per DAY** — a bulk edit costs ~34 and CANNOT be rolled back.

**Production data**

- **NEVER rotate the Supabase DB password with `ALTER ROLE`** — dashboard only. `28P01` is a stale password, `XX000` a wrong host.
- 🔴 **A `TEST-…` login is a TEST ACCOUNT (`app_auth_users.is_test_persona`): it READS as the real employee in `test_persona_of_hr_id` and must never WRITE as her.** `resolveAccessContext` refuses its writes outside `/api/phoenix-crm/` and `/api/auth/`; never widen that list — give a module a test world first. Its Phoenix CRM rows carry HER hr id with `is_test = true`, so every `phoenix_crm_*` read keyed by a person must filter `is_test`. Account: `docs/test-accounts.md`.
- **`expense_claims` is the ONE live RLS read path in production.** Put a precondition in every shared-queue production `WHERE`; **"Log out everywhere" is THREE writes.**
- **The 255 lower-cased `ats_candidate_status_events.actor_hr_id` rows STAY, by owner decision** — `canonicalHrIdKey` already matches them. Do not re-propose a repair or disable the trigger.
- **The `expense_claims` mirror builds `claimed_total` and `approved_total` from TWO tables**, so a stale request header breaches `expense_claims_approved_total_range`. **Read the expense components before touching an approved amount**; the rebuild flags `data_quality_hold`.
- 🔴 **Production has NO PITR — 7 daily backups are the whole recovery story.** Say so before any bulk or destructive change, and **never restore a daily backup in place.**
- 🔴 **Payroll reads `social_insurance_wage`, NEVER `social_insurance_status`, and NEITHER statutory figure reduces take-home pay.** Audit by querying both columns; never warn a wage costs the employee money. `payroll-reads-the-insurance-wage-never-the-status` · `social-insurance-and-tax-never-reduce-take-home-pay`
- 🔴 **A HELD payroll row is DROPPED at publish with no trace** (`publishToPayslips` filters `!onHold`). **HELD = OWED PART 2 ONLY** — validate part 2 against PUBLISHED rows; `payroll_eligible=false` is normal for executives; read `hold_reason`, never re-raise. `a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace`
- 🔴 **A VACATION BALANCE IS RECOMPUTED, never read from a snapshot** — INSERT the missing days; a back-dated PAID insert RE-SEQUENCES every later row. **Never UNPAID — those zeros are deliberate** — and skip leavers (owner). `salary_records.unpaid_vacations` is a SECOND path that has really taken money: price it by `unpaid_duration_days`, never by dates. `vacation-balance-is-recomputed-live-snapshots-are-display-only`
- 🔴 **HIRING ONE PERSON BREAKS ACHIEVEMENT EVERYWHERE** — an `employees` insert auto-seats them AND flips `line_area_map.area_state`, which is hashed into the attribution fingerprint, so periods go stale and the rollup stops answering. **RE-STAMP AFTER ANY HIRE**, and never hand-write occupancy. `an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing`
- 🔴 **Auth metadata keys `phoenix_role`, NOT `role`** — a migration writing `role` matches 0 rows and VERIFIES ITSELF GREEN on the wrong key. And `banned_until` is NOT deactivation: authority is `is_active` + `employment_status`. `auth-metadata-role-key-is-phoenix-role-not-role` · `deactivated-accounts-are-mostly-not-banned-at-the-auth-layer`
- **A `not_found` on `marketing_pharmacy_distributor_codes` is a stale CACHE** — join the live `source_of_sales_customer_map` before telling the owner a venue's territory is unrecoverable.
- 🔴 **A shared distributor customer code CANNOT prove two direct-order venues are the same** (each distributor has its own codes). Use byte-identical order lines from one DM in one brick, or matching building numbers; **never merge on name similarity or your own inference — put the pair to the owner.**
- 🔴 **An area holds SEVERAL `teams` (named for regions), so RENAMING one corrupts other lines.** Resolve from the seat region (`au.v_org_tree.region_name`); read `team_id`, never the dead `team_name`/`department_name`.
- 🔴 **`sos_map_guard_customer` silently DROPS a held customer-map move** (fewer rows, no error). Read `sos_map_change_holds`, never the row count; release only via `sos_map_guard_decide`, never mint a permit.

**Which environment the code thinks it is in**

- **A LOCAL run writes PRODUCTION but skips every email, and the local Resend key CANNOT send** — send from production with `railway run`.
- **STAGING cannot rehearse a PRODUCTION shape.**
- **`isProductionRuntime()` reads `APP_ENV || VERCEL_ENV || NODE_ENV`, and a production build sets `NODE_ENV=production` on staging** — `APP_ENV` must stay set there (fixed).
- **Staging email is safe only because `PHOENIX_EMAIL_FORCE_TESTING` is set explicitly — one variable, nothing behind it.**
- **The `APP_ENV`/cron-secret hole is CLOSED — do not re-chase it**, but treat `!isProductionRuntime()` as an auth fallback with suspicion.
- **The `railway` CLI is linked to `production` — every variable command needs `-e staging`.** Setting a variable redeploys (unless `--skip-deploys`). 🔴 **THAT NAMES THE ENVIRONMENT, NEVER THE SERVICE — and the PRIMARY checkout is linked to `phoenix-headwind`, not the app.** So `railway run` there injects the wrong service's variables and `CRON_SECRET` reads as ABSENT, which looks like a half-rotated secret and sends a session hunting a rotation §2.3 forbids. **Always pass `--service phoenix-people-workforce`**; a worktree answers `No linked project found` instead. `railway-cli-is-linked-to-phoenix-headwind-not-the-app` Account: `docs/agents-production-hooks.md`.
- ✅ **RESOLVED 2026-09-30 — the second undocumented project (`superb-smile`) is GONE, so the deploy gate IS now assertable: ONE project deploys this repo, and its production trigger reads `checkSuites: true` (staging and `phoenix-headwind` read `false`).** Read the trigger, never a doc. Account: `docs/agents-production-hooks.md`.
- **That deploy serves in MINUTES — confirm by listing DEPLOYMENTS**, never by probing the app, and never `railway redeploy` to make a variable "take".

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
- 🔴 **THE SOURCE OF SALES AUDIT IS FINISHED — never restart it.** Its findings are a FIX backlog: start from `sos-remeasure-2026-09-06.md` in the vault (`RESUME-2026-09-05.md` records completion). Never restart the finder agents, never `resumeFromRunId`, never overwrite the inputs — write a NEW file.

**How to build**

- **Before building new UI, match the sibling pages' exact design identity.** Never invent a one-off look.
- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.** Use `<table className="w-full table-fixed">` with a `<colgroup>`; fit by MERGING columns, never shrinking type — `overflow-x-auto` over a `min-width` IS the bug. Measure `scrollWidth > clientWidth` over `main` at desktop and 375px; `shrink-0` makes an inner `flex-wrap` inert. `never-horizontal-scroll-always-mobile-and-desktop-friendly`
- Admin shell: **desktop shows full tables/dashboards, mobile gets cards.**
- 🔒 **THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.** `tokens.css`'s `--phx-radius: 4px` is the bug; measure computed `border-radius`, since `globals.css`'s sweep is not coverage. Restoring premium polish from history re-rounds corners — take the depth only. Pinned by `tests/admin-shell-palette-scope.test.ts` and `tests/hiring-pack-paper-editor.test.ts`.
- 🔒 **THE DOCUMENT IDENTITY — every company document wears `SATO-DIS-2026-01 v1.0`** (Sato Pharma's, never the app's); "put it in the system template" is STANDING. Logo palette `#0A527D`/`#0A6BA6`/`#1482C2`. 🔴 **THE INK RULE — no filled areas** except the 6% zebra row; government forms are exempt; on paper the mark is `sato-pharma-logo-on-light.png`. Module: `src/lib/hiring-pack/house-identity.ts`. `the-house-document-identity-standard`
- **One production deployment per task.** Bundle all phases into one PR.
- ⏸️ **DORMANT under the mobile-app freeze at the top of §4** — do not act on this, do not raise it.
  🔴 **MANAGED GOOGLE PLAY REACHES NO REP TABLET — the store `.aab` is NOT how the mobile app ships, and the upload is DROPPED** (owner, 2026-09-28: *"drop the managed play upload since it cannot reach the fleet"*). Measured the same day: `enterprises/LC017auv4o` has **0 enrolled devices** and the package answers **404**, because the tablets are enrolled in the company's own **Headwind MDM**, which installs an **APK it hosts** and links to a configuration — and they carry no Google account by design. **The fleet artifact is `eas.json`'s `mdm` profile** (arm64 APK, `production` channel), a dispatch choice on the Mobile build workflow since #4652. Never read a green store build as fleet cover, and never re-propose the Play upload as the way to ship to reps. `managed-play-cannot-reach-the-rep-tablets`
- 🔴 **PULL REQUESTS ARE BACK ON GITHUB-HOSTED, AND THE BOX IS A PREVIEW MACHINE ONLY** (owner, 2026-09-30, reversing his own widening the same day). `CI_SELF_HOSTED` is **off** — the kill switch, never an edit to the `runs-on` expression, which is UNCHANGED, so one variable restores widening and the rule below stays live. Reversed because the box cannot fit TWO concurrent `checks` jobs, and one runner serialises them slower than hosted. 🔴 **A RUNNER SELF-UPDATES AND DOES NOT COME BACK** — `svc.sh`'s unit carries `Restart=no`, so it reads offline with nothing red to show it: **never register one without checking `systemctl show <unit> -p Restart`.** The box keeps serving `phx-preview` (§5). Account: `docs/ci-self-hosted-runner.md`, "REVERSED the same day".
- 🔒 **THE THREE THINGS THAT STAY TRUE WITH THE SWITCH OFF**, because the `runs-on` expression is unchanged and one variable flips it back on. 🔴 **`github.event_name == 'pull_request'` is the ONLY thing keeping `main` hosted, and `main`'s CI IS the production deploy gate (§2) — never weaken it, nor the same-repo clause** (a fork PR self-hosted is arbitrary code execution on his box). 🔴 **Restoring the `startsWith(github.head_ref, 'ci-runner/')` clause narrows his 2026-09-30 ruling and is NOT a cleanup.** 🔴 **THE HARDWARE REFUSAL STANDS** (*"I WILL NOT BUY THIS"*) — he bought ONE box himself: never re-pitch a purchase, and never argue widening from hardware that does not exist. Pinned by `tests/ci-runner-switch.test.ts` in the required `checks` job. Account: `docs/ci-self-hosted-runner.md`, "Widening it".
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.

**Product rules that must not be "fixed" back**

- No payslip on any overview/landing page for any role — not the amount, not even the month label.
- ⏸️ **DORMANT under the mobile-app freeze at the top of §4** — the one live half is the web side:
  `phoenix_app_shell=1` defaults FALSE and must stay, because removing it strips the WEB portal's
  chrome for every browser user. 🔒 **THE MOBILE APP IS A SHELL OVER THE WEB PORTAL — NEVER REBUILD A PORTAL SCREEN NATIVELY** (owner, 2026-09-29). Home and every module render the production `/employee-portals` pages in a WebView; **native is login, Phoenix CRM and Profile, nothing else**. 🔴 **The `phoenix_app_shell=1` gate defaults FALSE and must stay** — removing it strips the web portal's chrome for every browser user. Pinned by `tests/native-web-handoff.test.ts`. Account: `docs/agents-owner-rules.md`, "The mobile app is a shell". `the-mobile-app-is-a-shell-over-the-web-portal`
- 🔒 **THE AUTOMATED PAYROLL EXPORTS stay Phoenix black-and-orange, EXEMPT from the house identity** (run sheet, finance downloads, step templates); the published batch download and payslip renderer stay house. Keep the held row's NOTE and the step template's cell LOCKING. Pinned by `tests/payroll-phoenix-look.test.ts`.
- 🔒 **THE OFFER LETTER DESIGN IS FROZEN** — `src/lib/offers/` keeps its blue, navy bands, tinted salary table and circular disc; no house-identity rule reaches it.
- 🔒 **NO COMPANY SEAL ON A HIRING DOCUMENT — THE STAMP IS THE JOB OFFER'S ALONE** (owner, 2026-09-29: "remove the sato pharma stamp/seal from all hiring documents, leave it only in job offers"). Nothing in `src/lib/hiring-pack/` draws one — contract, clearance, custody receipt, renewal, worker form, salary letters and all 19 HR papers render blank signature cells, and `house-identity.ts` exports no seal to draw. 🔴 **The خاتم / خاتم الشركة / Company stamp column HEADINGS STAY** — they name where a human presses the real stamp, and the clearance clause refuses the form until one is on it. A pre-stamped document is a document NOBODY STAMPED, and copying the offer's seal across is the obvious-looking improvement that is REFUSED. Pinned by `tests/hr-forms-house-papers.test.ts` in the required `checks` job. 🔴 **THE PRINT-TIME MARK IS NOT AN EXCEPTION TO IT — a session that reads it as a violation and rips it out deletes work he approved the same evening** (`tests/hiring-pack-document-marks.test.ts` goes red if the vocabulary goes). The ruling is about WHO stamps: a mark takes TWO human acts and renders without either, and **nothing may ever tick for him.** 🔴 **The NDA stays HAND-stamped** — its cells have no room for the seal at any height; never place a mark on it and never offer to. Account: `docs/agents-owner-rules.md`, "The seal a human presses". `the-nda-stays-hand-stamped-it-has-no-room-for-a-seal`
- 🔒 **THE SPOTLIGHT SHEET KEEPS ITS FILLS — the crest band, the plinth and the stat band are owner-approved exemptions from the INK RULE**, decided 2026-09-12 after he was asked in writing. Do not "bring them into line" with `SATO-DIS-2026-01`, and do not re-raise it. The rank chip going from a tinted box to two rules was a separate, accepted change — it is not a precedent for the other three. `src/lib/spotlight/pdf.ts`.
- 🔴 **THE SPOTLIGHT SHEET’S ARABIC MARK IS A PLACEHOLDER THE OWNER IS REPLACING HIMSELF — leave it on the sheet until he sends the official asset.** `public/brand/sato-pharma-arabic-on-light.png` is AI-generated and hand-edited (four dots removed; `tests/phoenix-official-logo.test.ts` goes red if the recipe puts them back). It is KNOWN, it is DECIDED, and it is his to close: never remove it, never regenerate it, never ask again. When the real file arrives, swap it and re-pin that test.
- 🔴 **THE 06:55 CRM DAILY DIGEST IS LIVE AGAIN — never delete its schedule.** Refused 2026-09-27 and RESTORED 2026-09-28 at the owner's own instruction; the slug still reads "refused" and the memory corrects itself in its first line. 🔴 **THE DURABLE RULE CUTS BOTH WAYS: a declaration and its cron job move in ONE sitting, never one without the other** — a declaration with no job reads to `job-heartbeat-assess` as a job that has STOPPED and alarms every Super Admin for ever, and a RESTORED declaration also carries `watchingSince` or it alarms about a stand-down window it was never scheduled for. Pinned by `tests/phoenix-crm-daily-digest.test.ts` and `tests/job-heartbeat-register.test.ts`. Account: `docs/agents-owner-rules.md`, "The 06:55 CRM daily digest". `the-0655-crm-digest-is-refused-never-schedule-it`
- 🔴 **A REJECTION NOTICE IS NEVER SENT AUTOMATICALLY**, in either channel, and already-rejected candidates are settled. **The planner built that day was removed the same day — do NOT rebuild it, and never read the two recipient sheets he was sent as a queue waiting for a send path.** Keep `isBatchActor` (`src/lib/recruitment/batch-actor.ts`).
- 🔒 **THE PROBATION DAY 30 / 60 / 75 EMAILS GO TO YASMEENA ELSAFORY (`HR-009`) ALONE, BCC OMAR GAWISH (`B-10`)** (owner, 2026-09-29) — never the retired stakeholder fan-out. 🔴 **This does NOT re-open probation email: the `probation` policy stays `enabled = false`** (it still drives the legacy per-manager reminders); the milestones carry their own type, `probation_milestone`. An older memory reading "probation email stays OFF" is about that policy, not these three. Due = crossed AND still on probation, never a grace window and never past day 90. Account: `docs/agents-owner-rules.md`, "The probation Day 30 / 60 / 75 emails". `src/lib/probation/intelligence/milestone-emails.ts`, pinned by `tests/probation-milestone-emails.test.ts`.
- 🔒 **YASMEENA ELSAFORY (`HR-009`) IS INFORMED OF EVERY ANNUAL VACATION REQUEST, AND HER LANDING PAGE NAMES WHO IS ON A VACATION TODAY** (owner, 2026-09-29). 🔴 **INFORMED IS NOT AN APPROVER — never add her to `approval-flow.ts`**, the obvious-looking implementation, which would make every annual vacation in the company wait on a third signature; it is ONE notice on submit, `normal` priority, no approve/reject button. 🔴 **IN-APP + EMAIL + TELEGRAM, all three** (owner, 2026-09-30) — removing a channel needs his word exactly as adding one did. **Pass NO `email` block** — `recipientHrId` alone resolves her own work address, and an empty `recipients` falls through to the shared `hr_notifications` inbox and still logs a success. Annual only; admin-RECORDED vacations notify nobody, by design. The panel is APPROVED leave covering the Cairo day, every type, as NAMED people and deliberately not a tile — and a failed read renders NOTHING, never "nobody is on a vacation today". `src/lib/vacation/informed-recipients.ts` · `src/lib/vacation/on-vacation-today.ts`, pinned by `tests/vacation-informed-hr.test.ts` in the required `checks` job. Account: `docs/agents-owner-rules.md`, "Yasmeena is informed of every AV".
- 🔴 **THE SYSTEM NEVER AUTO-APPROVES A PLAN — a DM's weekly plan is submit → NSM (or RSM) → HR acknowledge, NO CEO stage.** No system-signed APPROVAL (`SYSTEM-AUTO-HR-ACK` on the acknowledgement stays); never skip a stage by writing a decision row for it. DM plans carry NO `ceo_approve` row by design — do not restore one, and never delete a human decision on a fabricated-row predicate. **One exception, owner 2026-09-20: DMs reporting to Hany Saad run submit → Hany → Ali Mohamed Ali → HR auto-ack** (`second-approver.ts`); Ali's decision rides the `ceo_*` slot, never the CEO's. `the-system-never-auto-approves-a-plan`
- 🔒 **A PHARMACY CALL IS A THIRD LIST, NEVER PLANNED, NEVER APPROVED, AND IN NO KPI** (owner, 2026-10-02). `list_type` carries `Pharmacy` beside AM and PM, and **26 existing readers across 17 files** are the binary `=== "AM" ? "AM" : "PM"`, which files a pharmacy among the DOCTORS with nothing going red — widening the union catches NONE of them, so read it through `parseListType` and watch the ratchet. 🔴 **It is never on a weekly plan** (*"He don't plan it. We don't want extra"*), which REVERSES his own earlier "planned like doctors" the same morning; the 10-a-day cap capped **planning**, so nothing is left for it to limit and a cap on VISITS is the extra he refused. 🔴 **An unplanned pharmacy visit needs NO approval** (*"no approval for an unplanned pharmacy visit"*) — the off-plan approval exists to protect a figure, and a pharmacy has none. **No coverage, frequency, target, call rate or capacity reads one**; the Pharmacies figure stays a plain count, never a rate. `src/lib/phoenix-crm/pharmacy-call-rules.ts`, pinned by `tests/phoenix-crm-pharmacy-calls.test.ts`.
- 🔒 **A PHARMACY IS NOT A CONTACT — a CRM contact count is `PM` + `AM` only.** Pharmacies get their own tile; never name a pharmacy bag `contacts`. Row label **"Pharmacist"**, count **"Pharmacies"**. `a-pharmacy-is-not-a-contact`
- 🔒 **A REP NEVER SETS A GRADE, AND A CUSTOMER JOINS HIS LIST ONLY THROUGH THE DISTRICT MANAGER, THEN SFE** (owner, 2026-09-23; 2026-09-29). A carried-over customer keeps `v_ref.grade` and validating rewrites none. One met outside the list (an out-of-list visit, or "Add new customer") is validated at the door and waits as `outside` with `validated_at` NULL; the DM confirms or changes A/B/C and MUST set a **potential grade** (AA..BC — stored and shown ONLY, it moves no figure), then SFE admits him. 🔴 **Re-grading at the door stays REFUSED** — `phoenix_crm_decide_request` is the only writer. Pinned by `tests/phoenix-crm-pending-customers.test.ts` and `tests/phoenix-crm-list-admission.test.ts`.
- 🔒 **A PLACE IS VALIDATED ONCE, WITH TWO READINGS, AND IS FIXED FOREVER — only the Super Admin and the SFE Manager move it** (owner, 2026-09-23; 2026-09-29). The place is read TWICE (2026-09-30): the live photo with its own location, and a separate **Capture location** button that reads it again by GPS — both are stored, neither is a copy of the other; **the photo's reading is the fixed point**, the pin the fallback (`placePoint`); address · brick · area · region are resolved SERVER-side from it (`PlaceDraft` names no location; an old phone's keys are IGNORED). The rep edits only the place's name and its days and hours — never moves or removes one. A move needs a written reason and writes an audited `place_moved` event (`phoenix_crm_move_place`, one of the Super Admin's THREE real-data writes, `access.ts`), then every visit to that customer is measured again. Pinned by `tests/phoenix-crm-place-location-frozen.test.ts` and `tests/phoenix-crm-place-move.test.ts`.
- 🔒 **PHOENIX CRM GOLDEN RULE #1 — THE REP'S APP IS EASY, AND IT IS BLIND: it is the simplest thing he touches, and it NEVER lets him feel he is being checked** (owner, 2026-09-26: "very easy very simple … never make the medical rep feel that the system is here to catch him … never informed of any violation … recorded in the admin and the SFE account"). It outranks every other CRM rule; where a control and this rule collide, this rule wins and the control moves out of his sight. **EASY:** a visit is taps and ONE tap to log it — no photo, no date, no AM/PM (2026-09-29), the location read silently — plus a **REQUIRED comment**, typed or spoken (2026-09-30); nothing is asked twice; no field exists that the server can derive (date, place, brick, area, visit type are all resolved server-side). Adding ANY step to the rep's day needs his word first. **BLIND:** EVERY integrity signal is recorded and readable ONLY by the **Super Admin and the SFE Manager**; the rep gets no warning, no badge, no refusal, no wording anywhere that a check exists, NO distance on his own visit (`isLocationBlind`), and a flag NEVER changes a number or a word on his own screens. 🔴 **The boundary is WHOSE WORK IT IS** — his plan, his day, his targets and an approval HE asked for are his and stay visible; anything that judges his honesty is never his. Generalises the mock-location rule below to every check. Account: `docs/agents-owner-rules.md`, "Golden rule #1".
- 🔒 **THE VISIT TYPE IS CHOSEN BEFORE THE DOCTOR, AND AN OFF-PLAN VISIT COUNTS IN NOTHING UNTIL IT IS APPROVED** (owner, 2026-09-26). **Planned visit** offers ONLY the customers on a plan the rep has SENT for that day; **Unplanned** is **Out of plan** (his list minus today's plan: a written reason, then his manager and SFE approve the VISIT) or **Out of list** (validated on the spot: the DM and SFE approve the CUSTOMER, and the visit counts once he is admitted, in its own month — never if he is dropped or refused). Unplanned replaces the vendor's **Campaign (Prospection)** — do NOT import its other codes. 🔴 **"Planned" is NEVER "the customer is on a plan row"**: the rep owns his draft and today is editable, so that test lets him place the doctor at the door and the approval never happens — it is a plan that reached `submitted`/`approved` BEFORE the visit's server-issued `captured_at`. Approval is his **direct manager, THEN the SFE**; one refusal ends it; a vacant chain starts at SFE. Every KPI reads `phoenix_crm_countable_visits` — including `loadMonthVisitCounts`, a PostgREST read and not a report RPC — while `phoenix_crm_location_integrity` deliberately does NOT. Account: `docs/agents-owner-rules.md`, "The visit type, the off-plan approval". `src/lib/phoenix-crm/unplanned-rules.ts`, pinned by `tests/phoenix-crm-unplanned-visit.test.ts` and `tests/phoenix-crm-countable-visits.test.ts`.
- 🔒 **A REP PLANS ONE WEEK — THE ONE STARTING THE COMING SATURDAY — AND A SENT WEEK CHANGES ONLY BY REQUEST: THE DM, THEN SFE, THEN B-10 ACKNOWLEDGES, AND ONLY THAT REOPENS IT** (owner, 2026-10-01). `repPlanWeek`/`repWeekState`; the server refuses every other week on save and send; the rep has no month send and no take-back. A week is due the Thursday before it **at 23:55 Cairo, an INSTANT and never the end of that day** (owner, 2026-10-02 — `phoenix_crm_week_deadline_at` / `planDeadlineAt`), written on every due date a rep or a reviewer reads (`withPlanDeadline`); a late one is still accepted and stamped from the SERVER clock — never refused. `plannableWeeks` is the REVIEWERS' window, not the rep's. The request's five notices are Phoenix CRM's ONLY email (`PHOENIX_CRM_EMAIL_EVENT_TYPES`). Account: `docs/agents-owner-rules.md`, "Weekly only" and "The deadline is 23:55 Cairo".
- 🔒 **A STARTED PHOENIX CRM TEAM IS COUNTED FROM PHOENIX ON EVERY OTHER SCREEN, AND ITS REPS' iREPORTS360 VISITS AFTER ITS START ARE IGNORED** (owner, 2026-10-02: "From the team's start"). Delta (1) from Sat 3 Oct; 🔴 **any other team ONLY when the Super Admin presses Start on it** ("Only when I start it" — every line is open, so an automatic start let one stray draft drop a whole team's iReports360 visits into the deduction readers); its first sent real week only NOTIFIES him. `phoenix_crm_team_starts` is keyed by the DM SEAT; `crm_visits_unified` serves only COUNTABLE Phoenix visits for it. Never "restore" the dropped iReports360 rows, never count both, and never re-add an automatic start. Account: `docs/agents-owner-rules.md`, "The second Phoenix CRM batch".
- 🔒 **THE PLACE-VS-ACTUAL REPORT IS FOR THE DM, SFE, THE NSM AND THE SUPER ADMIN — NOT THE MEDICAL REP** (owner, 2026-09-26), gated server-side in `loadVisitLocationReport` as well as by the chip. 🔴 **The rep sees NO distance on his own visit** — the "Far from the place"/"Take care" line he kept on 2026-09-26 was REMOVED by him on 2026-09-29 (`isLocationBlind`); never restore it. It is NOT the mock-location board below, which stays Super-Admin-only and silent.
- 🔒 **DROP, ADD AND BRING-BACK ARE TWO STEPS — THE DISTRICT MANAGER, THEN SFE; A GRADE CHANGE STAYS THE DM'S ALONE** (owner, 2026-09-29). A dropped customer goes to the **Archive** (frozen; the SFE manages it and can bring one back himself); the rep may "Ask to bring back". A refused add is archived; the rep may drop an outside customer himself (he was never on the list). The step is read from the ROW (`stage`), never the phone. `src/lib/phoenix-crm/list-request-rules.ts`, pinned by `tests/phoenix-crm-list-admission.test.ts`.
- 🔒 **THE VISIT DAY ENDS AT 02:00 CAIRO** (owner, 2026-09-29: "maximum 2 AM") — `((captured_at − 2h) at Cairo)::date` in `phoenix_crm_save_visit`, `cairoBusinessDay` in TypeScript; never a past or a future day. Today, the visit form and day activities read `viewer.visitDay`; plans and reports keep the calendar day. Account: `docs/agents-owner-rules.md`, "The rep's flow rebuilt". Pinned by `tests/phoenix-crm-one-tap-visit.test.ts`.
- 🔴 **MOCK-LOCATION DETECTION IS SILENT — a spoofed capture SAVES, and the rep is NEVER told** (owner, 2026-09-25: "close this hole whithout reps knowing"). Never add a refusal, a warning, an error or ANY field a rep can see: a message teaches the one person you caught what to defeat. Android's `mocked` flag is recorded and the server proves the rest alone (replay · travel · zero jitter · accuracy · precision), so a patched build, the web and iOS are still covered — **do NOT "improve" it into a package/APK scan**, which needs `QUERY_ALL_PACKAGES`, dies to a rename and detects installation rather than use. Evidence lives in `phoenix_crm_location_integrity` (RLS, no policy, service role only), read ONLY by the Super Admin page `/admin/phoenix-crm/integrity`; a flag is where to look, never a verdict and never an action. Thresholds are set so an honest rep cannot trip them — **a false positive accuses a real person of fraud, which is worse than a missed catch**. `src/lib/phoenix-crm/location-integrity.ts`, pinned by `tests/phoenix-crm-location-integrity.test.ts`.
- 🔒 **100% REGULAR IS THE BEST CASE — campaign has NO floor, and campaign falling while regular rises is the best direction** (owner, 2026-09-21). Never reintroduce a "healthy band" or a "campaign-starved" flag; only a campaign MAJORITY is flagged, and a FALL in campaign share is the green direction. Account: `docs/agents-owner-rules.md`, "100% regular". Pinned by `tests/employee-360-campaign-mix.test.ts`.
- 🔒 **THE CALL RATE IS NEVER AVERAGED — AM against 2, PM against 10, reported APART**, with no combined figure anywhere. Never join the pair with a slash; use ` AM · ` / ` PM`. Pinned by `runKpiAttainmentAndIdentityTests` in the required `checks` job.
- 🔒 **THE AM · PM · PHARMACIES GOLDEN RULE — every count of visits is AM · PM · Pharmacies, three figures APART, and a pharmacy is NEVER counted inside PM (the doctors) or AM, whatever period the vendor tagged** (owner, 2026-09-21). One test, one helper: `src/lib/crm/visit-count-buckets.ts` — never a second copy. The outstation trip workload follows it too (#4185): a pharmacy-only trip is WORKED, never "No activity", and a trip stamped before the split reads "not counted separately", never 0. Pinned by `tests/visit-count-golden-rule.test.ts` and `tests/outstation-trip-workload-pharmacies.test.ts`. Account: `docs/agents-owner-rules.md`, "AM · PM · Pharmacies".
- 🔴 **THE CALL RATE'S LEAVER AND WINDOW RULINGS ARE DECIDED, not defects** (owner, 2026-09-21 — he chose B2/C1/D2 over the recommended B1/D1). A leaver or new hire is divided by the WHOLE month's working days — never prorate, never hide anyone before a start date; a rep who leaves mid-month DROPS OUT of the call-rate figures the moment HR marks him resigned — never "keep him to his last working day"; and every CALL RATE, on Reps List AND the KPIs board, scores through YESTERDAY — the RATE ONLY, while coverage and frequency still count today. Never re-propose proration or move the rate back to today. `CALL_RATE_THROUGH_YESTERDAY` in `src/lib/crm/reps-plans.ts`. `reps-list-rulings-b2-c1-d2-leavers-keep-whole-month`
- 🔒 **THE HEALTH CARD ON EMPLOYEE MASTER IS THE GOVERNMENT BOOKLET, AND THE INSURANCE JOB TITLE IS THE ONE ALREADY ON FORM 1** (owner, 2026-09-29, both asked and answered). "استلام بطاقة صحية" is دفتر التأمين الصحى الحكومى — `employees.health_card_*`, NEVER the company's private medical insurance beside it, so never merge the two pairs. "المسمى الوظيفى فى التأمينات الاجتماعية" is `employee_hiring_profile.job_title_ar` surfaced on the sheet, so never add a second insurance title that can disagree with the contract. 🔴 **A hiring-document column's header carries "(document)" because a document NAME is typed by HR and a header is what the upload matches on** — one named "Position" or "Status" would otherwise be read back and overwrite that field with the word "Submitted". Pinned by `tests/employee-master-workbook.test.ts`.
- Marketing Manager is hidden from the portal Incentive tab; GPM still sees it.
- The Organogram / AU seat model is the source of truth for org-structure and vacancy data.
- 🔒 **CAIRO PEDIA IS EMPTY ON PURPOSE — the DM seat and all five rep seats, and the owner has ruled it NEGLECTED until he hires** (2026-09-30: *"we will hire soon neglect cairo pedia dm and reps now"*). 🔴 **Never raise it as a finding, a gap, a data-quality issue or a `Next step:`**, and never single it out in a report that lists vacant seats or unmanaged areas — it is the expected state until he says otherwise. Never fill it either: a vacancy is a hire in progress, `hire_rpc` is the path, and the seat's own history holds only a RESIGNED person (`PD-0006`), so restoring him would assert a resigned employee holds a live seat. Where Cairo work must reach a person, route it to the Pedia NSM (Ali Mohamed Ali Elsayed, `A-12`) and say on the row that the DM seat is vacant. `cairo-pedia-is-empty-on-purpose-a-hire-is-coming`
- 🔒 **AN NSM SEES ONLY HIS OWN LINE — on Reps List, KPIs, Reps Plans, CRM Master, Double Visit, the direct-order venue picker and the Planning Calendar** (owner, 2026-09-20). Never move `doctorListBasisForRole("National Sales Manager")` back to `company`, and never special-case him in the venue picker or the calendar. **An acting District Manager (DM app role, Medical Rep title) sees EXACTLY what a District Manager sees — her team, never her own row; do not re-raise.** A team scope's "active" is `isActiveLifecycleStatus`, so a declined-offer person is dropped everywhere. Account: `docs/agents-owner-rules.md`, "NSM scope".
- 🔒 **AN AREA IS NOT PER LINE — A REP SEES ONLY HIS OWN LINE'S SPEND ON HIS PATCH** (owner, 2026-09-30, a "fatal mistake": the Gharbia 2 Pedia rep saw the CNS DM's campaign — *"it doesn't mean that he is the same area that he see his line"*). `public.areas` rows carry **`line_id` NULL**, so ONE area id is held by every line's rep there: area-only gave **46 of 82** pairs to another line, on **28 of 72** reps. The ROI territory route is area **AND** line (`territoryRouteAdmitsRequest`): an unknown line is REFUSED, a lineless rep gets NO route, never an area-only fallback. 🔴 **Customers and pharmacies stay LINE-AGNOSTIC** (his 2026-08-19 treasure ruling) — a shared doctor is not a shared campaign. Account: `docs/agents-owner-rules.md`.
- 🔒 **THE MONTHLY-CLOSING SOURCE-OF-TRUTH GOLDEN RULE — the Monthly Closing module is the ONE source of truth for every SALES *and* every TARGET figure, system-wide** (owner, 2026-08-13; **targets made explicit and the rule ordered locked everywhere 2026-09-27**: "your source of truth to calculate any sales any targets is the monthclosing module, lock this golden rule everywhere in system"). Every surface — Sales vs Target, overviews, portal landings, command centres, incentive achievement, Employee 360, **Business Review** — computes BOTH the sales and the target it divides by through the closing engine, and must equal the **PUBLISHED** closing for that person and month; a page that re-derives either half from its own query, its own table or its own period is the bug, never a variant. Weekly Sales, Marketing ROI and the **Business Review pack** are the carve-outs — never invent a fourth. 🔴 **THE BUSINESS REVIEW READS THE LIVE ENGINE, NOT THE PUBLISHED SNAPSHOT** (owner, 2026-09-28, asked directly and answered *"use the live one"*). It is a REVIEW, not a payout record, and the two diverge for reasons correct on BOTH sides — a direct order counts in the month Finance books it, and the engine resolves geography as of the period — so the snapshot would understate real money and freeze a stale geography. **Never "fix" the Business Review back onto the snapshot, never republish a month to make them agree, and never acknowledge the drift to silence it.** A partial-window or per-page TARGET that inflates an achievement is the same defect on the denominator side. Account — the measured drift, line by line: `docs/agents-owner-rules.md`, "The Business Review reads live". `sos-monthly-closing-is-the-only-sales-truth`
- **SoS attribution is PERIOD-AWARE** — `au.f_monthly_attribution`/`au.f_monthly_achievement` resolve an area's region via `au.f_line_area_map_asof(period_end)`, never today's geography.
- 🔒 **A CRM account label is `[Name ]( Area / Line )`; `E`→`A` and `F`→`P` are RETIRED codes** (live: `A`, `C`, `P`) — never an open question. The CRM admin deactivates and CLONES, never deletes: **cloning is safe; RENAMING corrupts numbers.**
- **The Delta (3) territory move is LIVE and complete** (`D11`, `D24`, `D25`, `OT2`, `OT9`, dated 2026-09-01) — do not re-apply, re-date or "finish" it; `recruitmentAreaRegionOverrides` is PERMANENT. Keep `delta3_defer_backup_20260829.line_area_map_pre`; **never repoint `code_region_code`.** 🔒 **From 2026-09-01 `OT2`+`OT9` are ONE Anti Infective area, "Ismailia and Suez"** (dated `CLOSING_AREA_MERGES` rule; Aug stays two) — never split it back or re-key sales.
- 🔒 **THE AUGUST / DELTA (3) GOLDEN RULE — the August closing NEVER contains Delta (3).** Already enforced (`runClosingPeriodDatingTests`); **never resolve closing geography at the run date**, and **never offer to publish August “now that the move is live” — the DATE is the mechanism.**
- 🔒 **THE AUGUST / UPPER EGYPT GOLDEN RULE — Pedia's Upper Egypt splits into UE-1/UE-2 on 2026-09-01, and August NEVER contains the split.** **UE-1** Fayoum, Beni Suef, Minia 1-2, Assuit 1-2. **UE-2** Sohag 1-2, Qena 1, Qena 2, and **LUXOR, which is NOT a separate area** — it rides in as `other_permanent` with no rep seat. Aswan stays in Others. **PEDIA ONLY** — do not "align" Anti Infective's `UE-1`/`UE-2`, whose membership DIFFERS (Assuit is UE-2 there, Fayoum is Giza); the DATE is the mechanism. 🔴 El Qema's divisor goes 37 → 39. Pinned by `tests/pedia-upper-egypt-split.test.ts`.
- 🔒 **Delta (3) is ANTI-INFECTIVE ONLY.** On CNS and Pedia the five areas never move; "half-migrated" is the CORRECT state.
- 🔒 **THE AUGUST / KAFR EL-SHEIKH GOLDEN RULE — Kafr El-Sheikh 1 joins Delta (1) on PEDIA from 2026-09-01, and August NEVER contains the move.** Anti Infective already filed it there; **CNS keeps it on Alex-BHR for good** — half-migrated across lines is CORRECT, never "align" CNS. 🔴 **Kafr El-Sheikh 2 STAYS in Others**, which is what holds El Qema's divisor at 39: unlike the Upper Egypt split this move shifts NO money, in EITHER month — a changed El Qema number is a DEFECT, not an effect. The DATE is the mechanism. Pinned by `tests/pedia-kafr-el-sheikh-delta-1.test.ts`.
- 🔒 **THE CLOSING GOLDEN RULE — never RELEASE a closing during the month it covers** (publishable the first day of the next month, Cairo). Enforced by `src/lib/sales/closing-period-gate.ts` + `tests/closing-period-gate.test.ts` in the required `checks` job; `unpublishClosing` stays ungated. No override flag.
- 🔴 **A PUBLISHED AND ANNOUNCED MONTH IS NEVER CORRECTED, however justified the fix.** A late ruling is a rule for UPCOMING months. `monthly_closing_locks` is his decision — unlock only when he says so about that month. `never-fix-a-published-and-announced-month`
- 🔴 **FROM SEPTEMBER 2026 NO DISTRIBUTOR'S BONUS IS EVER COUNTED — any distributor, as units or as value — and a bonus cell NEVER drops a row's PAID units.** A sale is its units × factory price, nothing else. **August and every earlier published month keep whatever bonus they counted** — never re-import or correct one to apply this (the rule above). Account: `docs/agents-owner-rules.md`, "No distributor's bonus is counted from September".
- 🔒 **THE CITY RULE ALWAYS WINS — a wholesaler's sales split evenly over its OWN city's areas, even when its goods demonstrably LEFT the city**, except EZ (`evenSplitApplied`), Office, and El Qema's warehouses. **Never reintroduce a per-customer apportionment override.**
- 🔒 **EL QEMA (`QM`), PEDIA ONLY — 3 bands, then the صعيد pass, then the lead ladder.** Per warehouse per product on the month total: **≤200** governorate only; **201–699** half governorate, half rest of country; **≥700** flat over the republic. Qalubeya = Qalubeya + Cairo, evenly — 🔴 **the 60/40, 75/25 and PRIORITY LADDER are GONE, so finding one missing is a DECISION, never a gap to repair.** The صعيد pass runs in EVERY band: Upper Egypt's credited sales pooled, half back across it, half over the republic. Then Qalubeya first, Tanta (D14) and Mahalla (D15) level behind, 2% per tier (`QEMA_LEAD_TIERS`), once per line and product, NOT in `splitTargetsFor`. 🔴 Upper Egypt membership is `UPPER_EGYPT_AREAS`, never August's region codes. `store-sales-city-split.ts`, pinned by `tests/qema-warehouse-split.test.ts`.
- 🔒 **EL QEMA LEAVES NO TRACE IN A CLOSING DETAIL** — its detail ROWS are REMOVED for everyone but Super Admin (and `scope: "system"`); blanking was tried first and announced the hidden money. The standard workbook's distributor breakdowns and Source Coverage keep the money under an unnamed `—` (owner, 09-14); totals untouched. **Never invent a source.** Mask after every computation and before every render (`closing-source-mask.ts`; only the closing export passes `revealSource: true`), pinned by `tests/closing-source-mask.test.ts`.
- 🔒 **THE WEEKLY BI AND NSM/DSM EXPORT DESIGNS ARE PASSWORD-LOCKED** in `src/lib/sales/weekly/export-design.pins.json` (values and formulas are not). Re-pin only via `scripts/weekly-export-design-unlock.ts --unlock`; 🔴 **never fix a red design test by editing the pins.** NSM/DSM stays BEIGE; the BI book keeps the house identity. New capability ships BESIDE. `tests/weekly-export-design-lock.test.ts` · `tests/weekly-nsm-dsm-beige-look.test.ts`.
- 🔒 **THE PREMIUM MONTHLY CLOSING KEEPS ITS OWN EXECUTIVE LOOK** — rounded buttons, filled navy bands and its own navy are owner-approved exemptions. Pinned by `tests/closing-executive-look.test.ts`; the reference file is a spec, never a template. 🔴 **That look is THE WORKBOOK'S ONLY — the closing SCREEN stays Phoenix orange.** The screen was branded to the Sato workbook palette on 2026-09-12 at his request and he reverted it the same morning ("i mean the full front ui return orange as it was"), after five rounds on the Target column's ink alone. **Do not re-apply the workbook identity to a closing screen, and do not "fix" screen and download to match** — they are deliberately two looks.
- 🔒 **THE OLD MONTHLY CLOSING EXPORT IS FROZEN — every new closing feature ships BESIDE it**, in the premium export. The shared `runExport` is pinned by `tests/sos-ui-truth.test.ts`. `the-old-monthly-closing-export-is-never-touched`
- 🔒 **The premium closing workbook FILLS the `.xlsm` engine — it never rebuilds one.** Never round-trip it through ExcelJS; rewrite the data parts inside the zip, and ship the template EMPTY. `premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it`
- **Every weekly report and export MUST set `excludeUnmapped`, and an export must MATCH the screen** — label, never silently drop. The Weekly Summarized Report's LAYOUT AND SCOPE are locked; its ink is the house identity.
- 🔴 **A typed payroll Addition (incentive, bonus, overtime) has NO ceiling** — owner, 2026-09-15: no refuse, no flag, no "large addition" warning; never re-propose one. `typed-payroll-additions-have-no-ceiling`
- **The system FLAGS an expense; it NEVER auto-rejects one.** Never auto-publish a deductions month or approve a batch yourself; a same-day CRM check reads zero — never report it as measured.
- 🔒 **A DUPLICATE EXPENSE CLAIM IS HELD, NEVER REFUSED** (built 2026-09-26 on the owner's instruction, after 351.00 was reimbursed twice for one May trip). All FOUR of person, day, destination and amount must match inside ONE payout run; the extra copies leave the PROPOSED figure only — they keep their full amount, stay in the trip breakdown naming the copy that is paid, and are subtotalled as "On Hold — Duplicate", so approving one or typing the amount still pays it. 🔴 **Never widen it to same-day-only** — all ten same-day trip pairs on production go to different destinations — **and never turn it into a unique constraint**, which refuses a real claim with no override and no words. `src/lib/automated-payroll/duplicate-expense-hold.ts`, pinned by `tests/duplicate-expense-hold.test.ts`.
- **CRM visit types `-5` (Public Holiday), `-6` (Casual Leave) and `-16` (Training, vendor-labelled "Unknown") are WORKING days.** `-4` is the only leave type, and only **FWC** reaches salary.
- **The Ready-sheet >25th full-pay waiver is for genuine RESIGNATIONS only** — terminated and inactive leavers stay prorated with zero allowances; a regional employee travelling TO Cairo earns no outstation per-diem; DSM and Medical Rep titles auto-provision their real role (the title-governance guard is DELIBERATELY relaxed for those two).
- **Social-insurance Form 1 prints exactly as the Authority issues it** — nothing Phoenix wrote on page 2, duplex.
- **The organogram XLSX keeps its Mobile column** (his override) — do not remove it.
- **The public Territory Management preview never shows the line** (pinned to Pedia server-side); the chart and employee popup read different sources; **the WhatsApp button stays on the CEO and NSM rows.**
- 🔴 **The CEO is NOT a district, and a picker is never wider than its viewer** — pass the viewer's scope to the PICKER as well as the query. `the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer`
- 🔒 **SCOPE RUNS DOWNWARD ONLY — never your own manager, nor anyone at or above your RANK.** Enforce it in `resolveDoctorCoverageScope`: the management chain plus a seat-rank ladder (`line` basis only); the viewer stays in his own scope; unranked titles are excluded. `scope-runs-downward-only-never-your-own-manager` **A DM never receives a DM CV.** `a-dm-never-receives-a-dm-cv`
- 🔴 **An NSM's outstation expense is NEVER held** — NSM only. `nsm-outstation-expense-is-never-held`
- 🔴 **An NSM's same-day-return outstation allowance is 300** — when `allowance = 300` exceeds `total`, raise the total; never trim the allowance.
- 🔴 **The mailbox-monitor app-password entry is `imap`** — never "Phoenix", never `___`. `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix`
- 🔒 **Turbify CANNOT issue app passwords centrally, and the owner is STAYING** — do not re-pitch a migration. `turbify-cannot-issue-app-passwords-centrally-owner-stays`
- 🔴 **A password reset does NOT revoke a Turbify mailbox** — also delete the app passwords, or suspend the mailbox. `public.mailbox_offboarding_tasks` rows are attestations. `a-password-reset-does-not-revoke-a-turbify-mailbox`
- **Four sales-attribution facts silently change a number:** EZ `1011654` splits evenly across Cairo+Giza CNS; the closing reads the DISTRIBUTOR-PRODUCT rollup, not `fact_rollup`; a case-duplicate `line_area_map` row doubles a line; "Stores" means `Office`, "UPA" is a channel. `ez-is-credited-evenly-across-cairo-giza-cns-reps` · `closing-reads-distributor-product-rollup-not-fact-rollup` · `a-case-duplicate-line-map-row-doubled-a-whole-line` · `owner-sheet-vocabulary-stores-is-office-upa-is-a-channel`
- 🔴 **A PRICE CAN NOW DIFFER BY PERIOD, AND SAGINKO IS THE ONE THAT DOES — `SA001` is 111.15 through 2026-09 and 170.52 from 2026-10** (owner, 2026-09-28: direct orders from that day, "the sales and target of the retail to be adjusted from 1 October"). 🔴 **`source_of_sales_products.factory_price` STAYS 111.15 — typing 170.52 into the Product Master screen restates Jan–Aug by +1,814,407 EGP, +194,852 of it on PUBLISHED July and +177,101 on PUBLISHED August.** The override lives in `source_of_sales_product_price_history`, read by `phx_factory_price(code, period)`, which FALLS BACK to the master price — so every product without an override row is valued exactly as before and the 2026-08-14 ruling still stands for it. 🔴 **The target half is where the money is:** `au.monthly_targets.target_value` is STORED while sales recompute, so Q4 targets must be units × 170.52 or Saginko achievement inflates 53%. `saginko-repriced-retail-from-october-direct-from-today`
- 🔒 **THE DIRECT-ORDER MONTH GOLDEN RULE — an order counts in the month Finance books it, at its pharmacy's own brick and area.** The closing is `phx_closing_distributor_product` PLUS `phx_monthly_closing_direct`: quoting the first alone understates, flipping its `not is_direct` double-counts. Blank-area `DIRECT` rows are the retired vintage. `direct-orders-are-counted-in-the-month-finance-books-them`
- 🔴 **Not every distributor uploads every month — "N of 17 missing" is never a finding.** Measure the EVERY-MONTH set; files land across the first two weeks; a stopped feed is not outstanding. `not-every-distributor-uploads-every-month`
- 🔴 **IS-S 2026-04 and 2026-05 are the SAME FILE, and the owner is leaving both pending** — never void, re-import or pick a month. Quoting either month quotes a doubled figure; say so.

### 4.1 Marketing customer, venue and licence validation

Full account: `docs/agents-owner-rules.md` §4.1.

- 🔒 **Venue validation is GPS + a live picture ALWAYS; leg 3 (the registered code, else the licence) is PHARMACY-only.** A non-pharmacy venue routes to **`admin`**, never `none`; a codeless PHARMACY is still refused. Direct-order desk only. **`nursery` = any venue with no distributor account — the owner's own filing, not a defect.**
- 🔴 **Marketing pharmacies are TERRITORIAL, and a NULL `area_id` makes one invisible.** **The REGISTERED CODE beats live GPS.**
- 🔴 **A CROSS-GOVERNORATE DISTRIBUTOR CODE IS A TYPO, NOT A REP GAMING YOU — MEASURE THE DISTANCE BEFORE YOU EVER SAY OTHERWISE** (owner asked it directly, 2026-09-29: *"الغلطات دي في الكود ولا الريب بيشتغلني"*). Measured across every validated customer↔pharmacy link carrying GPS on both sides: a median of tens of metres, **nothing over 2 km**, and both real incidents the right shop with a wrong number metres from the doctor. **A session that reports "the rep may be gaming you" on a code mismatch accuses a real person on evidence that says the opposite** — his own standing rule is that a false positive is worse than a missed catch. The cure shipped instead is the **GPS-ranked code picker** (#4797). 🔴 **The 4 km block (`VENUE_LINK_MAX_METRES`, his own figure that evening after refusing a tighter one — "no it block many") would have caught NEITHER incident: never tighten it believing it fixes the wrong-code class, and never FILTER the picker** — it ranks by area then governorate and shows everything. `src/lib/venues/customer-pharmacy-distance.ts` · `pharmacy-code-suggestions.ts`, pinned by `tests/venue-distance-rule.test.ts` and `tests/pharmacy-code-suggestions.test.ts`. Account: `docs/agents-owner-rules.md`, "A wrong distributor code is a typo". `a-wrong-distributor-code-is-a-typo-not-a-rep-gaming-you`
- 🔴 **`phx_resolve_marketing_pharmacy_codes` RUNS ONCE, AT CAPTURE, AND NOTHING EVER RE-RUNS IT** — a code entered before the sales master learned its pharmacy reads `unresolved` for good, so any count of "codes whose sales cannot be traced" is inflated by rows that became traceable afterwards. Re-resolve ONE row with that function, never a hand-written mapping and 🔴 **never in bulk — a code the master knows may belong to a DIFFERENT shop.** 🔴 **READ `validation_notes` FIRST: `unresolved` can be a signed human VERDICT, not a gap** — one carries the SFE Manager's own investigation with the distributor's invoice numbers, so re-resolving it overwrites a person's decision with a value that note rejects. The master's area can also contradict the capture's GPS; moving the venue is a SEPARATE act, and **the doctor moves WITH his pharmacy or you have created the split you were closing.** Account: `docs/agents-owner-rules.md`, "The marketing code resolver runs once". `the-marketing-code-resolver-never-re-runs`
- 🔴 **A licence verdict is PERMANENT, with no correction path.** **Ask the owner before the first one is recorded.**
- 🔴 **`system_validated` means NO HUMAN LOOKED.** The screen is **Super Admin only** — not SFE. A person's Approve on a link writes **`admin_approved`**, never it and never the desk's `sfe_validated`; the validated set is `LINK_STATUS_PRECEDENCE`.
- 🔴 **AREA governs both sight and reuse of a venue's evidence; never backfill ownership.**
- 🔴 **The badge must read the live evidence, not a frozen note** — EITHER half reaching `complete` clears it.
- 🔴 **A duplicate merge STRANDS the desk validation on the retired row.** Repair it with hand SQL, not code.
- 🔴 **The screen that SHOWS a badge is not the screen a rep can OPEN.** Check the gate before wiring any `actionUrl`.
- 🔴 **A WHOLESALER / MAKHZAN is NEVER shown as a candidate NOR validated as a venue — BOTH the direct-order and marketing flows** (owner, 2026-09-22, "never never never"). No makhzan flag exists; it is read from the monthly closing's NAME rule, reused via `src/lib/venues/wholesaler-venue-guard.ts` (imports the pure primitives of `customer-channel.ts`, never edits it). **Two tiers** (owner, "block certain, flag فارما"): `isCertainWholesalerVenue` HARD-BLOCKS the unmistakable warehouses (مخزن·جملة·trade phrase·QM·«م - »·named roster·code-keyed override) out of every picker AND write path; `suspectedWholesalerFlag` only FLAGS an ambiguous «X فارما / الشركة / الجمعيه / تريد» for the human, NEVER refuses. Pharmacy overrides (مخزن الطرشوبى) win first; the Super-Admin merge picker `listMarketingVenueMergeCandidates` is deliberately NOT filtered. Account: `docs/agents-owner-rules.md` §4.1. Pinned by `tests/wholesaler-venue-guard.test.ts`. `wholesaler-makhzan-never-shown-or-validated-as-a-venue`
- 🔴 **THE 286 VENUES FROM THE 2026-06-20 IMPORT CARRY NO GPS AT ALL, AND A BACKFILLED LINK WHOSE CUSTOMER SITS IN ANOTHER AREA IS NOT A DEFECT — READ `validation_notes` FIRST.** They are a bulk import, not field captures, so every GPS check is blind to them by construction and `checkCustomerPharmacyDistance` answers `not_comparable` rather than refusing — **never "close that hole"**, it would reject 286 rows that are fine. Of the 15 linked ones exactly two straddle areas, both saying *"inferred from pending/rejected historical marketing requests"* in their own notes, both confirmed by the REGISTERED CODE (§4.1's authority) against the customer's own five or six other pharmacies: **moving either side breaks six correct links to fix one.** Two links between the same customer and venue are NOT a duplicate — the grain is customer + `distributor_code_id`. `a-pre-gps-backfilled-venue-link-is-not-a-defect`

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
`pnpm run ci` as a pre-push ritual. **Push the branch and let the PR's checks answer.** The two
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
- Any UUID-named Supabase tool (a claude.ai account connector) stays deny-listed by default; `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087` remains denied. **Write the BARE server name in a deny rule** — a `__*` suffix matches nothing.
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
