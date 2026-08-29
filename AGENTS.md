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
   reverted it, confirmed 2026-08-09. That once meant the repo's `permissions.ask`/`deny` lists were
   no longer outranked — but on **2026-08-14 the owner had the `ask` list emptied**, so there are now
   no `ask` rules left in `.claude/settings.json` and **no dialog fires from a prompt rule at all.**
   (The `deny` list was emptied that day too, then the single block on the untrusted
   `mcp__b345e47e-…` Supabase connector was restored per §8 — a `deny` is a silent hard block, not a
   prompt, so it changes nothing about dialogs.) What auto mode still does **not** do is gate the work
   that matters: its classifier silently
   auto-approves a large share of routine calls, and no mode has ever prompted on a judgement call.
   **Every approval rule in section 6 is therefore behavioral: ask in plain words and wait for a
   plain answer** — that is now the only gate there is. Never offer a prompt that did not appear as
   evidence you were allowed, and read the settings file before asserting what is enforced — this
   paragraph named the wrong mode from the revert until 2026-08-12, and overstated the `ask`/`deny`
   lists until 2026-08-14.

## 2. Hard-Learned Rules (each cost a real incident — do not relearn them)

Evidence for these — dates, PR numbers, billing figures, measurements — is in
[docs/agents-incident-history.md](docs/agents-incident-history.md). Read it before changing branch
protection, CI cost, the deploy path, or the region.

- **Never use `gh pr merge --auto`.** `main` is branch-protected (`enforce_admins: true`) with **4 required status checks** — `validate`, `lint`, `typecheck`, `secret-scan` — that **DO gate every merge**. `allow_auto_merge: false`, so `--auto` is rejected anyway. Required reviews is **0** (a solo owner cannot approve his own PR; CI is the gate). Merge only with an explicit plain `gh pr merge` after separate owner approval.
- **Do NOT run `gh pr update-branch` reflexively.** A PR behind `main` is no longer refused — "require branches to be up to date" is **OFF** (`strict: false`, owner-approved 2026-08-05) because it was the dominant Actions cost and hit the spending cap, freezing every merge. Each run costs ~16 Actions minutes and discards the prior green CI. Run it **only when the change genuinely depends on something newly on `main`**, never as merge ceremony.
- **When you do run `gh pr update-branch`, it acts on the SERVER — your local branch is then stale.** The next `git push` is rejected with *"remote contains work that you do not have locally"*, which reads like someone else pushed. Always `git fetch` and `git merge --ff-only origin/<branch>` before committing anything more. It also moves the head SHA, so **CI re-runs and the previous green result no longer applies** — never merge on the older run.
- **A merge to `main` SHIPS TO PRODUCTION IMMEDIATELY.** This reversed on 2026-08-01 and is the single most important thing to relearn. Railway deploys on push, at full traffic, with no cron wait, no staged rollout, and no smoke test. CI gates the merge, but the merged commit then ships instantly. **Never merge anything to `main` you are not willing to have serving employees within minutes.** To confirm what is actually live, request `/api/healthz` and read `revision` — not the workflow list.
- **There is a staging application again** — a live Railway environment (`https://phoenix-people-workforce-staging.up.railway.app`), confirmed 2026-08-13, correctly wired to the staging Supabase project (`cifwmndunmlxjhyjugxa`), not production. It was already running when discovered, apparently created since the "no staging app" note below was written; the owner has confirmed keeping it. Any rule elsewhere in this file requiring staging verification now has somewhere to run against — see §3.
- **A local typecheck must not trust a warm TypeScript cache.** CI is authoritative — it always starts cold; a bare warm local `tsc` can report a false green. If you ever do run one by hand, use `tsc --incremental false`.
- **Never foreground-watch a long pipeline** (CI run, deploy, big script). Launch it in the background and check at batched checkpoints.
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), not the cookie flow — cookie-based role switching logs the real user out.
- **Merged-branch checks must be squash-aware.** PRs merge by squash, so a merged branch is never an ancestor of `origin/main` — `git branch --merged` is always wrong here. Use `gh pr list --head <branch> --state merged`.
- **A regression test only counts if you break the fix and confirm the new test's own headline assertion fires.** "The suite went red" is not proof — twice it was an unrelated old test or an adjacent assert.
- **`list_migrations` reports the migration ledger, not reality.** To prove an object exists, query `pg_class`/`pg_proc`.
- **Auto-git workflows are permanently banned.** Auto-executing commit/push/PR/merge was tried and reverted **twice**. Always ask first.

### 2.1 Session-level traps (hooks — full account in `docs/agents-session-traps.md`)

These are **agent-operating** facts, not Phoenix business rules. **Each line is a cue, not the
fact.** The full account of every one — measurements, dates, PR numbers, the diagnosis traps that
cost real time — is in **[docs/agents-session-traps.md](docs/agents-session-traps.md)**, verbatim and
unabridged. Search it for the hook's wording. Each hook also names the memory file(s) holding its own
record, under `C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\`.

**Why the split.** This file auto-loads in full on every request, so a hook here is seen *before* a
session knows it needs it — that is what the scarce bytes are for. A multi-paragraph write-up is only
wanted once a session is already looking, and paying for it on every request cost ~15,000 tokens of
context the conversation would otherwise have had. Same discipline `MEMORY.md` runs under, one level
up. **Adding a trap? Put the hook here and the account in the doc — never the account here.**

**Shell and tooling**

- **`grep -r` hangs on this checkout — use `git grep` or `rg`.** `shell-grep-unusable-use-git-grep-or-rg`
- **`pnpm run <script>` PURGES `node_modules`** when the lockfile moved. Invoke `node scripts/…` directly. `pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved`
- **`git show <ref>:<path>` returns EMPTY under MSYS**, and **`grep -c $'\r'` matches EVERY line of a pure-LF file** — use the PowerShell tool, or count raw bytes in node. A CRLF working copy can read as CLEAN too: git normalises before comparing. `git-ref-colon-path-is-mangled-by-msys-returns-empty`
- **A role probe cannot trust the HTTP status code**, and **a POST to ANY `/api/**` path returns 403 even when the route does not exist** — probe with GET. `a-role-probe-cannot-trust-the-http-status-code` · `a-post-to-any-api-path-returns-403-even-if-it-does-not-exist`
- **`curl -d "@-"` creates NOTHING on Windows** — write the JSON to a file and pass `-d @file.json`. `cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui`
- **Reads of `.env*` are auto-approved deliberately, for EVERY key** — licence to inspect, never to propagate. Do not re-litigate or narrow it. `env-file-reads-fully-auto-approved-2026-08-09`
- **A permission allow-rule stores the LITERAL command, so an inline env var bakes a live credential into `settings.local.json` in plaintext.** Grep any `settings.*.json` for `TOKEN=`/`KEY=`/`SECRET=` before sharing or merging it; merge bucket by bucket. `permission-allowlist-rules-can-embed-a-live-secret`
- **`mcp__supabase-staging__*` is broken** — route staging work through `mcp__supabase-production__*` passing the staging `project_id`. `supabase-staging-named-server-broken-2026-08-10`
- **The Supabase MCP returns ONLY the last result set of a multi-statement `execute_sql`** — earlier ones vanish with no error, so a block that verifies in statement one and summarizes in statement two certifies a check you never saw. One question per statement, or per call. No memory file; the account in the doc is the record.
- **A Windows USER env var SHADOWS every `.env.local`, silently** — `--env-file` only fills in what is missing. Which copy is live has already flipped once; re-probe all three, never print the value. `windows-env-var-shadows-every-env-local-key`
- **The local attendance agent dies at EVERY logon and loses NOTHING — do not escalate it.** Never disable the 2-hourly task, never launch a second agent (it can fire a PRODUCTION sync). `attendance-agent-crashes-at-logon-but-loses-no-attendance`
- **ExcelJS emits two schema-invalid OOXML fragments, so Excel silently REPAIRS the workbook.** `CT_SheetPr` child order and an unconditional `editAs` — both need the `.xlsx` zip post-processed, and four diagnosis traps sit on top. `exceljs-writes-two-schema-invalid-ooxml-fragments`

**Git**

- **Deleting a branch does not remove its pushed commit**, and **reusing a squash-merged branch makes a conflicting PR.** `deleting-a-branch-does-not-remove-a-pushed-commit` · `reusing-a-squash-merged-branch-makes-a-conflicting-pr`
- **`git push` hangs — kill at ~60s and retry.** The OOM was a 500MB `http.postBuffer`, **fixed 2026-08-23 to 8MB**; do NOT restore it. `git-push-to-origin-hangs-retry-immediately` · `git-push-oom-is-a-500mb-postbuffer-in-repo-config`
- **A merge to `main` mid-session silently orphans your next push.** `a-merge-mid-session-orphans-your-next-push-silently` · `two-sessions-fixed-one-bug-main-was-never-ci-validated`
- **`refs/deleted-*` is NOT automatic — a plain `git branch -D` archives NOTHING** (measured 96 → 96). Keep the SHA the delete prints; archive deliberately with `git update-ref` *before* deleting. `refs/backups/*` on ORIGIN is the only copy that survives losing this laptop. The glob needs the full prefix `'refs/deleted-*/**'`. `deleted-branch-tips-live-in-refs-deleted-branches`
- **An empty `git log <branch> --not --remotes=origin` is NOT proof a branch is safe to delete** — `git fetch` never prunes, so the check compares the branch against itself. Gate deletion on the merged PR. `not-remotes-flips-when-remote-refs-are-pruned` · `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **A UTC merge time read against a Cairo commit time INVERTS the merged/stranded verdict.** Compare instants, never wall clocks — and the answer is CONTENT (`git patch-id --stable`), never a timestamp. `a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal`
- **`git` "Authentication failed" can be the credential HELPER going OOM, not a bad token.** Look up the output for a Go panic; change NO credentials. `git-auth-failed-can-be-the-credential-helper-going-oom`
- **`F:\PHX backup` is the disaster-recovery set, and a bundle restore silently returns ZERO refs without `core.longpaths`** (0 without, 315 with). Three of its sections hold LIVE keys. `phx-backup-disaster-recovery-set`

**CI and PRs**

- **CI jobs failing in SECONDS mean billing, not code.** `ci-jobs-failing-in-seconds-means-billing-not-code`
- **`secret-scan` is a required check — there are 4 — and it is the one that never runs on a `main` push.** Its absence from a merge commit is CORRECT; do not hunt for it or dispatch it. `github-personal-account-no-ghas-oss-scanning`
- **`gh pr checks` LAGS behind the real job state.** `gh-pr-checks-lags-behind-the-real-job-state`
- **`check-runs: 0` also means CONFLICTED** — a conflicted PR runs no CI at all, which reads as "not started". `a-conflicted-pr-runs-no-ci-at-all`
- **ONE new hub page trips FOUR separate CI gates.** `adding-a-hub-page-trips-four-separate-ci-gates`
- **A red `main` still builds, ships and serves perfectly**, and a green PR is not a green `main` — after merging, check the run on `main`'s NEW head. `a-red-main-ships-and-looks-fine-build-ignores-type-errors`
- **Runs NEVER CREATED is an Actions OUTAGE, not billing** — billing creates the run and fails it in seconds. Check githubstatus BEFORE touching the spending limit. A `workflow_dispatch` run never enters a PR's `statusCheckRollup`, so it does not satisfy branch protection.
- **Simplest PR recovery: `gh run rerun <id>` on the PR's OWN `pull_request`-sourced run** — it keeps the `event`, so its checks DO reach the rollup. Wait for the backlog to drain first.
- **Then WAIT — dispatch lags 20–30 MINUTES during an outage, and the events are NOT dropped.** Fire ONE recovery event, then leave it half an hour before believing anything.
- **An extra SHA does not merely waste a run — it ACTIVELY KILLS the real head's.** `ci.yml`'s concurrency group is the same for every commit on a PR, so a replayed obsolete event cancels the head's run. Never push an empty commit to force a `synchronize`.
- **`actions/runs?head_sha=` needs the FULL 40-char SHA** — an abbreviated one returns `total=0` with no error, indistinguishable from "no runs exist".
- **A push to `main` during an outage ships to PRODUCTION with no CI run at all.** Recover with `gh workflow run ci.yml --ref main` — the rollup caveat does not apply to `main`.

**Migrations**

- **A migration FILE written is not a migration APPLIED**, and **a merged migration file does not mean the grants are live.** `migration-file-written-is-not-migration-applied` · `merged-migration-file-does-not-mean-grants-are-live`
- **Migration timestamps COLLIDE across parallel branches**, and **the ledger version never matches the filename.** `migration-timestamp-collides-across-parallel-branches` · `migration-ledger-version-never-matches-the-filename`
- **A PostgREST `.in()` carrying several hundred ids returns ZERO rows and NO error.** Chunk at ~50 and print the intermediate row count. `postgrest-in-with-hundreds-of-ids-silently-returns-nothing`
- **A `neq` against an ABSENT jsonb key matches ZERO rows** (0 of 390 where the truth was 19), and **an unbounded `.select()` stops at 1000** with no marker. Write the OR-form; `count(*)` before trusting any select, then page with an explicit `.order()`. `postgrest-neq-on-an-absent-jsonb-key-matches-nothing` · `postgrest-unbounded-select-silently-stops-at-1000-rows`
- **`n_live_tup` is STALE in production — it reports LIVE tables as empty** (`sales_records` read 0 against 11,267). Sweep with a real `count(*)` via `query_to_xml`. `n-live-tup-is-stale-use-real-count`
- **A Supabase client request that times out at 15s STILL COMMITS**, leaving a silent half-applied state with no audit row. Do heavy multi-step mutations in ONE `plpgsql` function. `supabase-client-15s-timeout-commits-anyway-half-applies`

**Database, grants and RLS**

- **A write REVOKE does NOT make a table read-only** — `ON DELETE CASCADE` and `SECURITY DEFINER` both run as the table OWNER, and `has_table_privilege` reports the revoke faithfully while seeing neither bypass. Fixed on prod 2026-08-14; **do not redo or undo.** `a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function`
- **An append-only table needs a STATEMENT-level `BEFORE TRUNCATE` trigger** — `TRUNCATE` fires no ROW triggers, and a revoke never binds the OWNER. Prove all three verbs are refused against a real database. `append-only-tables-need-a-truncate-trigger`
- **RLS on with no `authenticated` grant is the NORM here — 222 of 308 tables — not a defect class to sweep.** Granting is a pure widening. `rls-policy-without-an-authenticated-grant-is-usually-correct`
- **ONE `auth.users` row with `banned_until = 'infinity'` 500s the ENTIRE GoTrue admin API** — page-shaped, so a small `per_page` probe passes. Retire with the app's finite `876000h`. `banned-until-infinity-breaks-the-whole-auth-admin-api`

**Probing, attributing and reporting production**

- **A 200 from a health endpoint can be blind to the thing that is broken** — OpenAI's `/v1/models` certifies a key with no balance. The BILL cannot be read from the API at all. `openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules` · `openai-spend-cannot-be-read-from-the-api-reconstruct-it`
- **`app_error_events` returning 0 rows means QUIET, not broken.** Prove the route with 405 against a 404 control; never POST a synthetic error to production. `app-error-events-is-user-triggered-zero-is-not-broken`
- **The Error Monitor HIDES rows whose `environment` is NULL**, and a `create table … as select` copies rows but never RLS or policies — **measure the new table's ACL, never assume it either way** (both stale readings have cost something). `error-monitor-hides-null-environment-rows` · `ad-hoc-backup-tables-are-anon-readable`
- **`updated_by_hr_id` LIES about who wrote a row.** `how-to-attribute-a-production-write`
- **HR ids are MIXED CASE, so a plain `.eq` silently under-returns** — one `.eq` hid 28% of reps' own orders. **On `au.occupancy_history` the loss is TOTAL** (0 of 120 join; `lower()` matches all 120), and an occupancy row matching nobody reads as *a vacant seat*, not as a bug. Lower BOTH sides. `activity-events-hr-id-is-mixed-case-not-lowercase` · `direct-order-hr-id-columns-are-mixed-case-and-access-hrid-is-lowercase`
- **The Sato logo's wordmark is WHITE, so "SATO" vanishes on white paper.** `sato-logo-wordmark-is-white-invisible-on-paper`

**Validation**

- **A repo-wide pattern sweep must grep the TESTS for the old string too — a pinning test can pin the ANTI-pattern.** `runTest` rethrows, so a loop over N routes reports only the FIRST and hides every test after it. Run `git grep -l '<the exact old line>' -- tests` first, and fix the pin in the same commit.
- **A test name appended beside an existing one in `tests/run-tests.ts` becomes an ARGUMENT, not a registration** — `runTest` takes exactly two. One `await runTest(name, fn)` per test; check by AST, not a local `tsc`.
- **RAM-saturated? WAIT — do not skip validation for it.** `dont-skip-validation-for-ram-wait-instead`
- **Source-pinning tests slice a fixed BYTE window and false-FAIL** when the file shifts. `source-pinning-tests-slice-a-fixed-byte-window`
- **A heredoc eats backslashes** and yields a test that only ever passes. `heredoc-eats-backslashes-and-makes-a-test-that-only-passes`
- **`parseDiagnostics` is SYNTAX-ONLY — it cannot see a typecheck error.** `parse-diagnostics-cannot-see-a-typecheck-error`
- **`setState` inside `useEffect` is a lint ERROR here.** `set-state-in-effect-is-a-lint-error-here`
- **A green TEST run carries NO type signal** — `pnpm run test` strips types. Only the PR's `typecheck` job answers. `a-green-test-run-carries-no-type-signal-at-all`
- **A test can NEVER hand a function a `process.env` literal** — both spellings fail (TS2345 / TS2559), and each error only surfaces once you have fixed the other. Default the individual value at the signature, or take a `Record<string, string | undefined>`. `a-test-can-never-hand-a-function-a-process-env-literal`
- **An exhaustive `Record` does NOT gate the build** — `ignoreBuildErrors` lets a missing key compile, build and DEPLOY (NaN sort keys scattered 63 real candidates). Back any such `Record` with a RUNTIME assertion in a registered test. `an-exhaustive-record-does-not-gate-the-build-here`
- **A narrowed SELECT disarms every gate downstream of it** — test the SELECT, not the branch. `a-narrowed-select-disarms-every-gate-downstream-of-it`
- **An OPTIONAL field written UNCONDITIONALLY is a silent erase.** The PATTERN regenerates, not the two fixed call sites. `optional-field-written-unconditionally-is-a-silent-erase`
- **A feature can ship green, deploy cleanly, and be reachable by NOBODY — and zero usage is what both look like.** When a just-shipped feature shows zero usage, exercise the path end to end before concluding it is adoption. Check a shared list, never a local duplicate of one. `capture-evidence-was-dead-on-arrival-for-doctor-customers`
- **A merged fix on a path nobody has exercised is untested, not proven.** `payroll-mutations-were-unaudited-until-2026-08-21`
- **`cn()` SILENTLY DROPPED every `text-phx-*` size, and nothing in this repo can see it** — only `getComputedStyle` in a real browser does. The literal `text-[13px]` form was always safe: **the rename to a named size is what creates the bug.** `tailwind-merge-strips-custom-named-font-sizes`
- **`@/lib/utils` resolves to the ROOT `lib/utils.ts`, NOT `src/lib/utils.ts`** — editing the `src/` copy changes nothing, with no error. `ls <x>.ts` at the repo root first. `at-slash-lib-shadows-src-lib-via-tsconfig-paths`

**Memory and this index**

- **Sweep memories by CLAIM, never by filename or topic** — a topic sweep fixes the files a session reads when it is already being careful. Never rewrite a dated record. `staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones`

**Parallel sessions**

- **A parallel session can collide with NO git trace at all** — six instances; on one, `gh pr list`, `git log` and `git worktree list` were all clean while another session edited the same file in the primary. Read the SessionStart working-tree line as a collision signal. A stale lock proves the PID is dead, not that the folder is unattended. Resolve by MERGING, never discarding; if you report a finding to another session, it is theirs. `feedback-parallel-session-pr-collision`
- **ONE approval can reach SEVERAL sessions — N sessions holding the same "yes" is N executions.** Before executing a protected action on a terse approval, check how many sessions are live, say so, and re-verify the target immediately before acting. `mergedBy` naming the owner is NOT evidence of a human click. `one-approval-can-reach-more-than-one-session`

**Worktrees** (see also §5)

- **Another SESSION can remove a worktree under you.** `another-session-can-remove-a-worktree-under-you`
- **A gitignored `_wt-*/` scratch folder makes a worktree look clean.** `gitignored-wt-scratch-makes-a-worktree-look-clean`
- **The pre-push gate is GONE — a bare worktree pushes fine.** What it cannot do is RUN a suite; junction `node_modules`, invoke `node` directly, never `pnpm`. `bare-worktree-cannot-push-pre-push-gate-needs-node-modules`
- **"Permission denied" on `git worktree remove` still DEREGISTERS the worktree.** `worktree-remove-permission-denied-still-deregisters`
- **`--fix` / `--strip-idle` need exactly ONE live session**, and **`--fix` can NEVER clear a `_wt-*` husk.** Use `rmdir /s /q` **from PowerShell, not Bash**, then re-check `CreationTime`. `repo-doctor-strip-idle-cannot-run-with-sessions-open` · `repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm`
- **repo-doctor's RETIRABLE verdict names the branch a folder HAD at scan time** — re-read `status -sb -uall` and `git log origin/main..HEAD` at the moment of removal, never the report.
- **Every retirement gate can PASS on a worktree in active use** — nothing catches a live PROCESS. Two cheap signals see what the gates cannot: the newest mtime under `.next/`, and HEAD moving between the gate read and the removal. Read the tip at the GATE and reuse that SHA, or the rescue ref captures the wrong commit. Treat any scan older than the current command as fiction.
- **A squash-merged branch reads as "on NO origin ref" — that means BACKED UP, not stranded.** Never push a merged branch to "rescue" it; `git branch rescue/<name> <tip>` is the zero-risk move. `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **Self-removing a worktree MUTES its own session-end guard.** `self-removing-a-worktree-mutes-its-own-session-end-guard`
- **`next dev` CANNOT run in a worktree — the junction §5 prescribes is what breaks it.** Verify against the primary checkout instead; do not burn more than one retry. `turbopack-cannot-resolve-a-junctioned-node-modules-here`

**Next.js runtime**

- **A >2MB `unstable_cache` entry KILLS the dev server** — throws only in dev, uncatchable, muted in prod. `next-2mb-data-cache-throws-only-in-dev-and-kills-the-server`
- **`unstable_cache` SERIALIZES, so a returned `Map` comes back `{}`** — the page works on exactly ONE render, then throws for the whole revalidate window, rendered as the admin error boundary (which reads as a permission redirect). No unit test can see it. Cache the ROWS. `unstable-cache-serializes-a-map-into-an-empty-object`
- **Standalone tracing copies FILES, not pnpm SYMLINKS**, and **a top-level `import sharp` 500s a whole PAGE** when the `.so` is missing. `next-tracing-copies-files-not-pnpm-symlinks` · `next-standalone-trace-misses-a-native-librarys-so-dependency`

**Browser and dev-auth**

- **A MINIMIZED window makes every browser reading LIE — check `document.visibilityState` FIRST.** Both surfaces report `hidden`; rAF stops entirely, so **dnd-kit cannot run at all** while plain `.click()` still works. Four false diagnoses came off this in one session. `javascript_tool` does not await a returned promise, and the isolated world cannot see React fibers. `a-minimized-window-makes-every-browser-test-lie`
- **Click by TEXT — blind coordinate clicks once fired a real production collection run.** `blind-coordinate-clicks-fired-a-production-collection-run`
- **Dev login is `GET /api/dev-auth?role=`** — header-only, so the Browser pane cannot role-switch DIRECTLY, but a local header-injecting proxy DOES work and concluding otherwise was a real error. A HIDDEN pane mixes correct rects with 0×0 ones; re-measure visible, but do NOT retract the number. `dev-auth-is-header-only-browser-pane-cannot-use-it`
- **Turbopack 500s with `0xc0000142` when the commit charge is exhausted** — close a session, do not debug the code. `turbopack-500s-with-0xc0000142-when-commit-is-full`
- **Verify a 375px mobile layout with NO dev server.** `verify-a-mobile-layout-without-a-dev-server`

**Machine ceiling**

- **The ceiling is the Windows COMMIT limit, not RAM — and a freeze leaves NO dump.** The limit FLOATS (47.79 GB floor, ~79.79 GB as the pagefile grows): **read it live, never quote it.** An empty `C:\Windows\Minidump` is the EXPECTED signature; the tell is `dwm.exe` dying `0xC00001AD`. **Never judge a process by `VirtualSize`** — that misread blamed `repo-doctor.mjs` for three freezes. Suspect breadth over any single process. `commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb`
- **Two decoys sit on that diagnosis:** `nvlddmkm` is what dies when the compositor is starved, not the cause; but the `node.exe` figures in **Event 2004 ARE real**. The largest leak found so far is a throwaway ExcelJS probe (22 → 41 GB in 40s, off-heap so `--max-old-space-size` cannot cap it). Delete such probes when done.
- **An interrupted session leaves the tree BROKEN ON PURPOSE.** Before acting on a bare "commit it", `git grep BREAK-`. `an-interrupted-session-leaves-the-tree-deliberately-broken`

### 2.2 The memory index (hooks — full account in `docs/memory-index-budget.md`)

**Each line is a cue, not the fact.** Why each rule exists, every trim pass with its byte counts,
what earns a line and what must come out, and the arithmetic behind the budget are in
**[docs/memory-index-budget.md](docs/memory-index-budget.md)**. Same split §2.1 runs under, and the
same reason: this file auto-loads in full on every request, so it pays for the cue, not the essay.

- **`MEMORY.md` is the ONLY memory file that auto-loads, and the loader truncates it at 24,400 bytes — SILENTLY.** No error, no marker: the tail simply stops existing, so a hook can be present in the file and absent from every session that reads it.
- **The budget is 22,000 bytes, and the 2,400-byte gap is deliberate slack** — about ten hooks, so several parallel sessions can append before anyone must act. `node scripts/repo-doctor.mjs` prints the verdict and the exact bytes to free; `.claude/hooks/memory-index-guard.mjs` puts the same figures into every session at SessionStart, before it appends anything.
- 🔒 **THE DISPLACEMENT RULE — never add an index line without freeing at least as many bytes in the same edit.** Retire a resolved hook or relocate one. This is the only part that changes the outcome: the file is append-only in practice, so any "trim it when it gets big" plan loses to the append rate by construction. One verified 718-byte trim bought fifty minutes before two sessions had refilled it.
- 🔒 **IGNORE the "compact it to under 17.1KB" message.** It fires on EVERY edit to `MEMORY.md`, looks authoritative, and asks for something arithmetically impossible — measured unreachable twice, because the dominant cost is filenames plus `[]()` link syntax, which shrinks ONLY by deleting a memory. Landing under the cliff with real headroom is a SUCCESS. It is built into Claude Code, cannot be disabled from this repository, and that is why the counter-rule has to live here.
- **Route by KIND of fact, never by topic** — an agent-operating trap to §2.1, a production or approval hook to §2.3, an owner product rule to §4. All three auto-load in full and have no cliff, so a relocation costs the index nothing. **Reach is identical; only scannability differs**, which is why the index's scarce bytes must hold what a session needs *before it knows it needs it*.
- **Never delete a hook to make room, and correct the FILE before the hook.** The frontmatter `description` decides whether a memory is recalled at all, so fixing only the index line leaves the error where it does the most damage. A stale hook costs more than a missing one — it gets defended rather than looked up. The floor is structural — most of the index is hooks that have to exist, and the filenames alone are a large share of that — so measure it before trusting any target, and do not gut it chasing a smaller number. `memory-index-floor-is-13kb-dont-gut-it-chasing-17`
- **What earns a line — all three, not two of three:** a session would act WRONGLY without it, it is durable (never a count, a status or a date — those rot invisibly), and it is not derivable in one step. **Sweep by CLAIM, never by filename or topic**, and never rewrite a dated record. `staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones`
- **A relocation spanning git and `~/.claude/` must finish BOTH halves or neither, in that order** — the destination must be **merged** before the index line is trimmed, or the fact briefly exists in neither auto-loaded file. `scripts/memory-index-reachability.mjs` matches a **backticked slug in `AGENTS.md`**, so a hook written on an unmerged branch correctly still reads as an orphan. **Before cutting any section out of this file, check which slugs appear ONLY there** — moving that text orphans every one of them that no index line covers.
- **No required check can gate any of this.** `MEMORY.md` lives under `~/.claude/`, outside the repository, so CI never sees it — the doctor is a local report and the displacement rule is behavioural. That is precisely why the cap is written here, in the file that auto-loads in full.

### 2.3 Production and approval hooks (relocated from `MEMORY.md`, 2026-08-27)

**Compression ran out, exactly as §2.2 predicted it would.** Measured that afternoon, `MEMORY.md`
sat at **24,234 bytes against the 24,400 ceiling - 166 bytes of headroom**, with **zero** trailing
whitespace, **zero** double spaces, and **one** em-dash left (the August pass had already converted
the other 102). The only remaining lever was all 41 bold pairs, worth 164 bytes - and 166 bytes is
**less than one hook line**, so a trim could not have fitted even a single new pointer, let alone
the four that were waiting. So this block moved here instead, per §2.2's own instruction. Each name
is the memory file under
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\`.

Two lines that sat under the same `MEMORY.md` heading did **not** come with it - the Egypt-centroid
geocoding hook and the brick-mapping hook are data-quality facts filed under a Railway heading, not
production-ops guidance. They stay in the index.

**Railway deploys**

- **A deploy applies NO migrations**, and **auto-deploy can silently SKIP a race.** A merge that
  never shipped looks identical to one that did until you read `/api/healthz`.
  `railway-deploy-applies-no-migrations` · `railway-auto-deploy-can-silently-skip-a-race`
- **`railway variables --stdin` stores a BOM**, which then travels inside the value.
  `railway-stdin-bom-trap`
- **`railway ssh` JOINS argv and lands as ROOT** - the command you think you are quoting is not the
  command that runs. `railway-ssh-joins-argv-and-lands-as-root`
- **`railway service source connect` is NOT environment-scoped — `--environment staging` REPOINTED
  PRODUCTION** (relocated from `MEMORY.md` 2026-08-28 together with its index line). The flag reads
  like `railway variables -e staging`, which genuinely is environment-scoped; this one is not. The
  CLI's own help says so: `-e, --environment <ENVIRONMENT>  Environment to use for resolving the
  service` — *resolving* the service, not choosing what to change. The git source is a
  **service-level** setting shared by every environment of that service, so connecting a branch
  repoints them all. Measured 2026-08-28 ~04:38 Cairo on this repo: one command meant as a
  staging-only test of an unmerged PR put `codex/retire-modules-control` on BOTH environments, and
  `https://phoenix-hr.satopharma.com/api/healthz` returned **`revision: 24f736bc`** — production
  serving an unmerged feature branch at full traffic, with two already-merged commits rolled back.
  The rule that follows is absolute: **a branch cannot be staged on Railway without shipping it**,
  so never reach for this command to preview anything. Four more things that incident proved,
  each of which nearly sent the diagnosis the wrong way. **Both environments moved together, and
  the revert moved both back** — that is how the service-level scope was confirmed from the other
  direction rather than assumed. **§7's "smoke-test on staging before a risky production deploy"
  therefore cannot be done by repointing a branch** — it needs a separate Railway service. The
  damage was never the feature: that branch was green on all four required checks and inert (0
  rows in `sidebar_module_assignments`, all 16 roles 200). The damage was that production
  silently **rolled back two commits merged minutes earlier** (#2508, #2509, recruitment fixes) —
  **a green branch is still the WRONG code when it is older than `main`, and `healthz` reporting
  `status: ok` hides that completely, so read the `revision`.** And last, `railway status
  --environment X --json` returns the WHOLE project, so a reader taking `environments.edges[0]`
  prints the same environment whatever `-e` says: staging and production printed identical lines,
  which reads as a parser bug and was nearly dismissed as one. Select by
  `.environments.edges[] | select(.node.name=="production")` and print the name you matched.
  `railway-service-source-connect-is-not-environment-scoped`

**Cron and secrets**

- **A PARTIAL `CRON_SECRET` rotation leaves TWO fingerprints**, and Healthchecks reading `up` is
  **not** proof of authentication - the grace window hides a 401. The 2026-08-23 401s are RESOLVED:
  **rotate NOTHING.** Always print `len` (the fingerprint is `Bearer …`, 71).
  `a-partial-cron-secret-rotation-leaves-two-fingerprints`
- **`CRON_SECRET` lives in TWO stores**, so a half-rotation 401s; and **a nightly-failing cron
  alerts NOBODY** or is ignored. The 4 OFF iReports360 jobs are DELIBERATE.
  `github-actions-cron-secret-went-stale-after-a-railway-rotation` ·
  `a-cron-that-fails-nightly-can-do-so-forever-unwatched`
- **The cron-job.org REST API allows 100 requests per DAY** - 429 on EVERY endpoint with no
  `Retry-After`, and a bulk edit costs ~34 and CANNOT be rolled back.
  `cron-job-org-rest-api-is-100-requests-per-day`

**Production data**

- **NEVER rotate the Supabase DB password with `ALTER ROLE`** - Supavisor holds its own copy, so
  use the dashboard only. `28P01` vs `XX000` tells a stale password from a wrong host; nothing off
  the laptop uses it. `never-rotate-the-supabase-db-password-with-alter-role`
- **`expense_claims` is the ONE live RLS read path in production.** Put a precondition in every
  production `WHERE` when another session shares the queue, and remember **"Log out everywhere" is
  THREE writes.** `expense-claims-rls-read-path-is-live-in-prod` ·
  `guard-every-prod-write-when-another-session-shares-the-queue` ·
  `force-logout-everywhere-needs-three-writes`
- **Production has NO PITR — 7 daily physical backups are the whole recovery story** (relocated
  from `MEMORY.md` 2026-08-28 together with its index line). Verified 2026-08-13 against the
  Management API: `pitr_enabled: FALSE`, `walg_enabled: true`, 7 daily backups retained.
  **Healthy WAL archiving is not PITR**, and concluding otherwise is the easy mistake —
  `pg_stat_archiver` shows 11,309 segments archived with **0 failures ever**, pushing every ~120s,
  and every Supabase project looks like that; restore-to-a-timestamp is a paid add-on this project
  does not have. So on a database that pays real employees, **recovery granularity is one day and
  the restore unit is the whole database** — say that plainly before any bulk or destructive
  production change, and **never restore a daily backup in place**, which rolls back everything
  since roughly 07:30 Cairo that day. `production-supabase-has-no-pitr-only-daily-backups`

**Which environment the code thinks it is in** (the first two relocated from `MEMORY.md`
2026-08-27, and they live HERE now — their index lines are gone, so this block is the only thing
that recalls them. The room that bought paid for the `APP_ENV` hook, which does have an index
pointer: the index carries the hook, this block carries the detail.)

- **A LOCAL run writes PRODUCTION but silently skips every email**, and **the local Resend key CANNOT
  send** — it is restricted, on an unverified domain. Send from production with `railway run`.
  `local-run-against-prod-db-silently-skips-every-email` ·
  `local-resend-key-is-restricted-use-railway-run-to-send-from-production`
- **STAGING cannot rehearse a PRODUCTION shape** — the surgery that proved this was only ever made
  against prod. `staging-cannot-rehearse-shapes-only-prod-surgery-made`
- **`APP_ENV` was UNSET on Railway `staging`, so staging identified itself as PRODUCTION** — and two
  things quietly depended on that. `isProductionRuntime()`
  (`src/config/system-settings.ts:61`) and `currentEnvironmentLabel()`
  (`src/lib/error-monitor/service.ts:69`) both read `APP_ENV || VERCEL_ENV || NODE_ENV`, and a
  Next.js production build sets `NODE_ENV=production` **on staging too**. Measured 2026-08-27: 43
  staging variables, no `APP_ENV`; production had it. **Fixed** with
  `railway variables --set "APP_ENV=staging" -e staging -s phoenix-people-workforce`, proven by
  POSTing one synthetic error to staging's `/api/errors/client` and reading the row back
  (`environment: production` → `staging`; both probe rows deleted after).
  `app-env-unset-on-staging-made-it-look-like-production`
- **The email fail-safe did NOT cover staging.** `isForceTestingDelivery()` returns
  `!isProductionRuntime()` when `PHOENIX_EMAIL_FORCE_TESTING` is unset, and its own comment says
  that default "keeps preview/dev from emailing real people" — but on staging it evaluated
  **false**, inverted exactly where it was needed. Staging was safe only because
  `PHOENIX_EMAIL_FORCE_TESTING=true` is set explicitly: **one variable, nothing behind it.**
- **FIXED 2026-08-27 (PR #2479) — the `APP_ENV`/cron-secret hole below is closed, all 22 of 22.**
  Until this PR, **18** cron/notification routes carried `if (!secret) return
  !isProductionRuntime();` — including `/api/notifications/process`, `/api/notifications/daily`,
  `/api/cron/background-jobs`, `/api/cron/recruitment-email-intake` and
  `/api/sales/master-map/sheet` — while only **4** (the three `ireports360-visits-*` plus
  `reconciliation-check`) used the hardened form `if (!secret) return process.env.NODE_ENV ===
  "development";`. Labelling an environment non-production used to flip that branch from closed to
  open, so with `CRON_SECRET` absent one variable change exposed all 18 at once — proven live on
  Railway staging: `MASTER_MAP_SYNC_TOKEN` was unset there, and `/api/sales/master-map/sheet`
  served ~49.7k customer records unauthenticated until this PR shipped. PR #2479 moved the
  remaining 18 onto the hardened form, so **`APP_ENV` no longer affects this fallback at all** —
  `process.env.NODE_ENV` is inlined at `next build`, so every deployed build (Railway has no
  `NODE_ENV` set on either environment) resolves the bypass closed regardless of `APP_ENV`. The
  `⚠ NEVER set APP_ENV without confirming CRON_SECRET` warning that stood here is retired for this
  specific risk — **`APP_ENV` still matters for the separate `isForceTestingDelivery()` email
  fail-safe two bullets up, which this PR did not touch.**
  **Treat `!isProductionRuntime()` as an auth fallback with suspicion generally, still:** it reads
  as "only in dev" and means "anywhere not labelled production", which includes any environment
  where someone simply forgot the label — the pattern regenerates itself if a future route copies
  it from an old comment instead of the current hardened routes.
- **The `railway` CLI is linked to `production` here** (`railway status` → `Environment: production`),
  so every variable command needs an explicit `-e staging`. Omitting it would set `APP_ENV=staging`
  on PRODUCTION, flipping `isProductionRuntime()` false there and redirecting **real employee email**
  into the test inboxes. Re-read both environments after any such change. Setting a variable **does**
  trigger a redeploy (unless `--skip-deploys`), and the change is inert until that deploy reaches
  `SUCCESS`.
- **That deploy fires in SECONDS but serves in MINUTES — and reading the gap as "no deploy" is a
  mistake already made here.** Measured on staging 2026-08-28: environment settled on `96fa5e19`
  `SUCCESS`; `railway variable set` at **08:57:42Z**, no `--skip-deploys`; deployment `6c805087`
  created **08:57:46.663Z** — 3 seconds later, on the SAME commit `fdc63919`, with no push behind
  it. Production carries the identical shape: `e84f0c05` at 07:57:56Z on `8f27b62b`, with no commit
  to explain it. So for the first minutes a correct trigger and a missing one look alike — the old
  container is still serving and the variable appears inert. On 2026-08-24 a session read exactly
  that window as proof Railway does **not** restart on a variable change, ran an explicit
  `railway redeploy`, and wrote the inverted rule into a memory file, where it stood until
  2026-08-28. **Confirm by listing DEPLOYMENTS, never by probing the running app**, and never
  `railway redeploy` to make a variable "take" — that is a second build of the same commit.

## 3. Stable Environment Facts

History and verification detail: [docs/agents-incident-history.md](docs/agents-incident-history.md).

- Production application: `https://phoenix-hr.satopharma.com` — **served by Railway since 2026-08-01, no longer Cloud Run.** Railway service `phoenix-people-workforce`, project `Phoenix-HR-Workforce`, environment **`production`**, region **`europe-west4-drams3a` (Amsterdam, EU West)**, 1 replica. **The region is deliberately colocated with the Frankfurt Supabase project (`eu-central-1`) and near the Cairo users — if production is ever re-platformed, it must stay in Europe** (measured: ~204ms from `sfo` vs ~75ms from `europe-west4`). Also reachable at `https://phoenix-people-workforce-production.up.railway.app`; Cloudflare holds `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied.
- **The `production` Railway environment's service now tracks git branch `main` directly** (repointed 2026-08-13 via `railway service source connect --environment production --branch main`). Before that it was source-configured to track a git branch literally named `staging`, which had gone stale — so five already-merged, already-CI-green PRs (#2093, #2095, #2094, #2098, #2097) sat unshipped in production for hours while `main` moved on, with no error or signal anywhere. **Do not assume "merge to `main` ships to production" without first confirming the Railway `production` environment's service source branch** (`railway status --environment production --json` returns the WHOLE project, so `edges[0]` prints the same environment whatever `-e` says — select by `.environments.edges[] | select(.node.name=="production")`, print the name you matched, then read `.node.serviceInstances.edges[].node.latestDeployment.meta.branch`; see §2.3) — the source can drift from `main` again with zero warning, since GitHub shows the merge as normal either way.
- **GCP is DEAD, not standby.** Billing closed 2026-08-01; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`. Do not "verify production" against Cloud Run. `deploy-cloud-run.yml` / `deploy-cloud-run-staging.yml` are trigger-disabled but intact.
- **The production scheduler is the third-party `cron-job.org`.** Automation is **running, not stalled**: daily notifications and iReports sync/reconcile fire from that account. The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** — a red herring, not proof anything is down. **Do not tell the owner notifications/iReports are stalled without checking `cron-job.org` first.** **It cuts every request at 30 s, that cut is a PLATFORM cap `requestTimeout` cannot raise — but the server DOES finish the work afterwards, so a long route logs a false `Failed (timeout)` while succeeding.** Both halves measured 2026-08-28 with a one-shot probe on `/api/cron/crm-contact-lists`: the API accepted and read back `requestTimeout=300` and the execution still recorded `status=5 http=0 ms=30108`; the route's own audit row — written LAST in the handler — then landed at 20:09:43 Cairo covering **all 82 agents, 9,518 rows, 0 failures**, about **70 s after** the client was killed. ⚠ **A MID-SWEEP SNAPSHOT READS EXACTLY LIKE A TRUNCATED ONE, and this line carried the resulting error for one commit.** A query run at 20:09:02 while the sweep was still writing returned "39 of 68 agents re-stamped" and was reported as proof the work half-applies; it was just the run in progress. **Never judge completion from row timestamps while the job may still be running — read the terminal artefact** (the audit row, the response body from `GET /jobs/{id}/history/{identifier}`, the final log line), or re-query only after the route's full known duration has elapsed. Slicing a long route into several ticks is still right, for the honest reason: a permanently red job is one nobody reads, the response body is never seen, and completion otherwise depends on a detached request surviving a container restart. `/api/cron/crm-contact-lists` is the worked example — one twelfth of the roster per tick, 12 ticks 5 minutes apart inside one hour, measured at 8-10 s each. `src/lib/cron-control/*` is a dashboard over the dead GCP scheduler and remains inert.
- **The OUTBOX DRAIN is the one that needs care — it runs perfectly and did nothing for 13 days.** cron-job.org job **8200914** hits `/api/notifications/process?limit=50` **every 5 minutes**, returns **HTTP 200** in ~3–5s, and returned `"outbox":{"attempted":0,…}` on every single cycle from **2026-08-14** to **2026-08-27**. It was never down, never 401, never unscheduled — so **a green cron and a 200 prove nothing here.** The cause is a **head-of-line block** in `loadDueNotificationOutboxRows` (`src/lib/notifications/email.ts:1998-2007`): `.limit(50)` is applied **in SQL**, then `attempts < max_attempts` is filtered **in JS afterwards**. 50 permanently exhausted rows (`attempts = 5 = max_attempts`, created 2026-08-09 → 08-14, all with `next_attempt_at IS NULL`, which *matches* the due predicate) filled the entire batch window; the JS filter then emptied it, so `attempted` was 0 forever and **nothing newer was ever reached.** Consequence, invisible from the product because inline sends still work: **every retry was silently dead** — any mail whose inline send failed queued behind the blockage and was never retried. **Cleared 2026-08-27 ~18:15 Cairo** by retiring those 50 to `status='skipped'` (reversible, `last_error` marked); the window now returns **0** rows. **FIXED 2026-08-27 — the code bug is gone.** #2462 (`9f61f582`) made the loader page past dead rows; #2464 (`2e93c273`) then moved `attempts < max_attempts` into the SQL query itself, on **all three** drains — telegram and push carried the identical defect, 25 and 16 dead rows against the same 50-row window — so exhausted rows can no longer consume it. #2468 (`c943d46f`) added the alarm that would have caught this on the first cycle rather than after 13 days: every run asks whether a queue had work due **before the run started** and attempted nothing, and on that shape pings the dead-man's switch **fail** with the reason and writes a `drain_stranded` ERROR log. #2470 (`4a64464f`) added the THIRD channel, because those two only reach someone already watching a dashboard or an inbox: it **pages a human in-app + Telegram** on the existing `weekly_system_health_digest` audience (retarget or silence it at `/admin/notification-recipients` — no new key, no migration), bucketed per Cairo day **and** per exact set of stranded queues, so a strand that persists across ticks alerts once a day while a NEWLY stranded queue still gets through. **Deliberately no email, and do not “fix” that back** — this alert fires precisely when the notification pipeline is the thing not delivering, so an emailed alert would depend on the channel it is reporting broken. It is best-effort and never throws: a failed alert must not turn a stranded drain into a second, self-inflicted incident. **`attempted: 0` still cannot by itself tell idle from broken** — read `drainHealth` in the response body. **Never infer a cron's health from database state alone, or from its status code** — read its execution history *and* its response body (on cron-job.org the job-list endpoint returns an empty body; only `GET /jobs/{id}/history/{identifier}` carries it). To check the drain, run its own window query — `status in ('pending','failed')` AND `(next_attempt_at is null or next_attempt_at <= now())` ordered by `created_at` **limit 50** — and count how many of those 50 are already exhausted. `outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line`
- **There IS a live Railway `staging` environment — verified 2026-08-13, and confirmed to keep.** Same project, service `phoenix-people-workforce`, reachable at `https://phoenix-people-workforce-staging.up.railway.app` (returns 200, `/api/healthz` responds). Its service source tracks git branch `main` (not the git branch named `staging`) — so confusingly, this Railway *environment* named "staging" was, until the production fix above, actually fresher than the Railway *environment* named "production". `railway variables --environment staging` confirms `NEXT_PUBLIC_SUPABASE_URL` points at the staging Supabase project (`cifwmndunmlxjhyjugxa`), not production — safe to use as a real verification target. Owner decision 2026-08-13: keep it.
- Vercel: fully legacy/decommissioned (old project `phoenix-workforce`) — never deploy to or verify against it.
- **Supabase project refs — the complete list `list_projects` returns, verified live 2026-08-23.** Two of these four belong to this app; the other two do not, and are listed precisely so an unfamiliar ref is identifiable instead of alarming.

  | Ref | Name | Region | Org | What it is |
  | --- | --- | --- | --- | --- |
  | `ozucdzovmcqvepbozvqf` | Phoenix HR | eu-central-1 | `rovnkzmhokgsruftjsaw` | **PRODUCTION** — real payroll data |
  | `cifwmndunmlxjhyjugxa` | Phoenix-HR-Staging | eu-central-1 | `rovnkzmhokgsruftjsaw` | **STAGING** (Pro org, created 2026-07-11) |
  | `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | `rovnkzmhokgsruftjsaw` | unrelated to this app |
  | `mlbpzvaanusdejqnimst` | the owner's personal project (his second, Outlook account) | eu-central-1 | **`xadcyivhxyjtehyheowl`** | unrelated — **different organization**, created 2026-08-11 |

  **Dead refs — treat any doc, memory, or prompt still naming one as stale:** `izhmxvgiktiafqusolot` (the prior free-tier staging) and `oaifhavixhdtwmseshff` (an older secondary project). Neither is returned by `list_projects` any more. This list named only the first as dead until 2026-08-23; both were live in older memories, and one of them sat in the `reference` memory a session consults to answer "which project is which".

  **Three of the four are `eu-central-1`, and a different organization does not stop anyone passing a ref** — so neither region nor org is a guard. Combined with the rule below that both named MCP servers see **all four**, the `project_id` argument remains the only thing that separates staging from production on every call. Resolve with `list_projects` before acting; never trust a ref pasted from a prompt or copied from an older doc.
- GitHub Actions secret `STAGING_SUPABASE_SERVICE_ROLE_KEY`: the staging service-role key, used by `ci.yml`'s login-smoke step (so its noise lands in staging, not production `audit_logs`) and by both staging legs of `migration-drift-check.yml`. **There is no `preview-smoke` job any more** — the smoke test is a step inside `validate`.
- **`.env.local` points at PRODUCTION Supabase.** `pnpm run dev` mutates production data.

Environment meanings — **Local**: this machine or localhost. **Preview**: the deployment generated
for the current branch. **Staging**: a preview connected to the staging Supabase project.
**Production**: the public production domain and production Supabase project.

Never store passwords, tokens, API keys, service-role keys, JWT secrets, connection strings, or
other credentials in this file or in Git. Never assume a pasted preview URL is current.

## 4. Standing owner rules (hooks — full account in `docs/agents-owner-rules.md`)

These are the owner's own decisions, stated across many sessions. They are not suggestions. **Each
line is the rule, not the evidence.** The full account of every one — incident narratives, PR
numbers, production measurements, the owner's own words at length — is in
**[docs/agents-owner-rules.md](docs/agents-owner-rules.md)**, verbatim and unabridged. Every memory
slug stays in THIS file on purpose: `scripts/memory-index-reachability.mjs` scans `AGENTS.md` only
and never `docs/`, and four of §4's slugs exist nowhere else, so moving one orphans the memory.

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in both UI and chat.
- **Never truncate text with an ellipsis and never let text wrap** to multiple lines in the UI.
- When asked for N recommendations, give only the ones grounded in a real confirmed need. **Never
  pad a list to hit a number.**
- End every reply with a single recommended next step.

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead** — do
  not start implementing while the list is still being given.
- **Ask when the answer changes the outcome; decide when it does not.** Scope, business rules and
  data-correctness questions are always worth asking; permission to do obvious low-risk work is not.
- **Ask business-fact questions as an XLSX with dropdowns, not in prose** (his rule, 2026-08-03).
  Whenever the doubt is "which of these does each of these belong to" — bricks to areas, people to
  seats, products to lines — build one row per item with a locked data-validation list of the allowed
  answers, include the context that makes the call easy and a free-text Note column, send the file,
  and read the answers back. Applies **everywhere in the repo**. Never guess an item to avoid asking,
  and never hand back a list for him to answer in chat.
- Take ownership. Automate the work rather than returning a checklist he has to execute.
- **"continue verifying" means RESUME the paused Source of Sales audit — never restart it.** Also
  "continue the verification" / "continue the audit". The 20 finder agents already ran; **he stopped
  the run specifically to save usage**, so re-running them repeats the exact cost he was avoiding.
  Read `sos-audit-2026-08-09/CHECKPOINT.md` first, then resume. Never
  `resumeFromRunId`. Never overwrite the inputs, and never move that folder into the work tree.
  `continue-verifying-resumes-sos-audit` · `sos-deep-audit-paused-checkpoint`

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
- 🔒 **A CRM account label is `[Name ]( Area / Line )`, and `E`/`F` are RETIRED line codes.** Between
  the brackets is the **area**; the letter after the final `/` or `-` is the **line**; a name, when
  present, sits **before** the bracket as `First.Last`. **`E` (anti-infective) became `A`; `F` (Pedia)
  became `P`** — `A`, `C`, `P` are the live codes, so an account still ending `/ E` or `/ F` is an
  old-naming placeholder and **never an open question**: nobody is hired into a retired code.
  **The CRM admin never deletes an account** — on a resignation he deactivates it, strips the name,
  keeps the area, then **clones** a new one for the next hire. The leaver's history therefore sits
  under a nameless label and the identity is **unrecoverable from the CRM**. **Cloning is safe;
  RENAMING is what corrupts numbers** — a relabelled hand-over rewrote 1,136 of a leaver's calls
  under the joiner's name, which is what `resolveEmployeeAttribution`'s employment-scoped override
  tier exists for (`tests/crm-override-employment-scope.test.ts`).
- **Delta (3) territory move — LIVE, dated 2026-09-01, applied as a migration 2026-08-29.** The five
  areas (`D11` Qalubeya, `D24` Sharkia 1, `D25` Sharkia 2, `OT2` Suez, `OT9` Ismailia) sit on a dated
  PAIR — the pre-split row closed at `effective_to = '2026-09-01'`, a `D3` row open from that date.
  **Nothing is owed on 1 September**: the date does the work, so do not re-apply, re-date, or
  "finish" anything. The resolver gap that made this dangerous is **CLOSED in both directions**
  (#2608 dates on the period, not the run date; #2613 added `public.au_v_line_area_map_all` so the
  closing can see the superseded half), so a forward-dated geography change is now safe to leave live
  across a closing. Keep the rollback pre-image `delta3_defer_backup_20260829.line_area_map_pre`.
  Nobody knows WHEN the August closing publishes — it waits on distributor data, not the calendar, so
  1 September is not a deadline to report as missed. **Two residues remain open:** the recruitment
  map's area menus (`src/lib/recruitment/inbound/whatsapp-classify-place-hints.ts`) still list these
  five under Delta (1)/(2), separately tracked.
- 🔒 **THE CLOSING GOLDEN RULE — a closing is never done or sent during the month it covers.** In his
  words: *"no closing is ever done or sent during the month. Closing after the month closes."* The
  closing for `YYYY-MM` becomes publishable on the **first day of the following month, Africa/Cairo**
  — 1 September for August, not a day earlier. Preparing a running month is fine and necessary;
  **releasing** it is what is forbidden, because publishing notifies every sales and product manager,
  arms the CEO's BI report, and a sent mail cannot be recalled by unpublishing. Enforced, not merely
  written down: `src/lib/sales/closing-period-gate.ts` throws and `publishClosing` calls it before it
  writes, pinned by `tests/closing-period-gate.test.ts` in the required CI `validate` check.
  **`unpublishClosing` is deliberately NOT gated** — it is the recovery path, and a recovery path
  that stops working when you need it is not one. Do not add an override flag, and do not offer to
  publish a running month "just to see".
- **Every weekly report and export MUST set `excludeUnmapped`** — an unmapped SKU double-counts
  against the real product. **An export must MATCH the screen**: never drop a sheet or column
  silently because it cannot be filtered — label it instead. The Weekly **Summarized Report's layout
  and scope are LOCKED** — do not restyle it. `unmapped-products-must-never-reach-a-report` ·
  `an-export-must-match-the-screen-never-different-data` · `weekly-summarized-report-owner-rules`
- **The system FLAGS an expense; it NEVER auto-rejects one.** Every failed check flags the claim for
  the Super Admin, who decides. **Never auto-publish a deductions month** and never approve a batch
  on your own initiative — CRM-derived detections run ~80% accurate, so it is always recommend, he
  confirms, then publish. **A same-day check against the CRM reads zero** because visits are entered
  through and after the working day — never report that as a measured zero.
  `system-flags-expenses-never-rejects` · `never-auto-publish-deductions-owner-confirms-first` ·
  `dv-evidence-window-same-day-submits`
- **CRM visit types `-5` (Public Holiday) and `-6` (Casual Leave) are WORKING days, never absence.**
  `-4` is the only real leave type, and only **FWC** reaches salary.
  `public-holiday-and-casual-leave-are-working-days`
- **The Ready-sheet >25th full-pay waiver is for genuine RESIGNATIONS only** — terminated and
  inactive leavers stay prorated with zero allowances. **A regional employee travelling TO Cairo
  earns no outstation per-diem** (live, #2160 — do not undo). **DSM and Medical Rep titles
  auto-provision their real role**, and the title-governance guard was DELIBERATELY relaxed for those
  two — do not restore the blanket-`Employee` assertion.
  `resignation-full-pay-rule-is-resignation-only` ·
  `cairo-trip-no-per-diem-allowance-live-prod-2026-08-15` ·
  `field-force-provisioning-live-and-guard-relaxed-2026-08-14`
- **Social-insurance Form 1 prints exactly as the Authority issues it** — page 2 carries nothing
  Phoenix wrote, and the whole form is duplex. `government-form1-prints-exactly-as-issued`
- **The organogram XLSX carries a Mobile column**, by his explicit override of the work-fields-only
  export rule on 2026-08-23. Fetched at export time: do not remove it, do not "simplify" it onto the
  row. `organogram-export-carries-the-mobile-by-owner-override`
- **The public Territory Management preview link must NEVER display or offer the line** — pinned to
  Pedia server-side. **The organogram CHART and the employee detail popup read two different
  sources**, so a per-person field on the chart means editing the seat report's select, not the
  directory. **The one-press WhatsApp button STAYS on the CEO and NSM rows** — he was asked directly
  and said keep it; do not add rank-based suppression.
  `territory-preview-link-must-never-show-the-line` ·
  `organogram-chart-source-is-au-seat-model-not-directory` ·
  `whatsapp-button-on-leadership-rows-is-an-owner-decision`
- 🔴 **The CEO is NOT a district, and a picker is never wider than its viewer.** An org walk that
  climbs to `AA` presents the whole board's scope as the CEO's own doctor panel — he holds no such
  list — and a cached company-wide filter tree offered a Medical Rep the names of all ~73 reps. **The
  damage is an EMPTY board**, which reads to a user as "you covered nothing" rather than as a bug.
  Pass the viewer's scope to the PICKER as well as the query, and never roll an org tree to its root.
  `the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer`
- 🔴 **An NSM's outstation expense is NEVER held** — *"once submitted, once accepted."* The workload
  gate could never clear for him anyway: an NSM has no CRM visits to match against. **NSM only** — it
  does not extend to the three photo-waived roles, and every other role still waits for a human.
  `nsm-outstation-expense-is-never-held`
- 🔴 **The mailbox-monitor app-password entry is `___`, never "Phoenix".** The entry name an employee
  types into Yahoo/Turbify is three underscores, and the monitor UI must never print the word Phoenix
  anywhere in that instruction.
  `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix`
- 🔒 **Turbify CANNOT issue app passwords centrally — the owner is STAYING, so do not re-pitch a
  migration.** There is no API and never was (a session claimed otherwise and was wrong): they are
  created browser-only, from inside each mailbox. Employee mailboxes are therefore **unmonitorable at
  scale**, and it is SETTLED — costed at ~$420/month for 60 seats on 2026-08-28, answered *"NO LEAVE
  ME AS I AM NOW."* `turbify-cannot-issue-app-passwords-centrally-owner-stays`
### 4.1 Marketing customer, venue and licence validation (relocated from `MEMORY.md`, 2026-08-28)

**Relocated because the index crossed its cliff — three times in one morning.** `MEMORY.md` is the
only memory file that auto-loads and the loader truncates it at **24,400 bytes**. On 2026-08-28 it
was measured at 24,605 with the tail already being dropped **silently**, and the line being lost was
the signpost saying session and tooling traps live in §2.1 — the one whose absence causes the next
session to re-add agent-operating hooks to the index and overflow it again. Per §2.2 the remedy once
compression is exhausted is to move guidance **here**, where `CLAUDE.md`'s `@AGENTS.md` loads it in
full with no cliff. These eight hooks are one coherent domain and three of them are explicit owner
rules, so §4 is their home. Reach is identical; only scannability changed. Each names the memory file
holding the full account, under
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\`.

- 🔒 **Venue validation is GPS + a live picture ALWAYS, and THEN either the registered code or the
  licence.** Owner rule, 2026-08-26. The licence is a **fallback identity route** for when the code
  is not in our database — it is *never* evidence in its own right. This governs the direct-order
  desk only (#2434), **not** marketing.
  `venue-validation-rule-gps-photo-then-code-or-licence`
- 🔴 **Marketing pharmacies are TERRITORIAL, and a NULL `area_id` makes one invisible.** Seeded rows
  carry no area and so appear nowhere at all. **Owner rule: the REGISTERED CODE beats live GPS.**
  `seeded-marketing-pharmacies-have-no-area-and-are-invisible`
- 🔴 **A licence verdict is PERMANENT and has no correction path.** It is write-once at approval: the
  write gate requires the caller to hold the request's *current* approval step, and once the request
  is decided that step stops existing — so not even a Super Admin can correct a wrong verdict, and it
  is then displayed indefinitely on a register. **Ask the owner before the first one is recorded.**
  The counts live in the memory file deliberately, because a hook whose content is a number is one
  that will one day be wrong.
  `a-licence-verdict-is-permanent-and-has-no-correction-path`
- 🔴 **`system_validated` means NO HUMAN LOOKED.** The admin register never blocks on it, and the
  screen is **Super Admin only** — not SFE.
  `marketing-system-validated-means-no-human-looked`
- 🔴 **A venue's evidence was WRITE-ONCE, writable only at insert** — fixed in #2352. **AREA governs
  both sight and reuse; never backfill ownership.**
  `marketing-venue-evidence-was-writable-only-at-insert`
- 🔴 **The badge read a FROZEN note, never the live evidence** (#2354). EITHER half reaching
  `complete` clears it, so setting both halves is a no-op.
  `marketing-badge-read-a-frozen-note-not-the-live-evidence`
- 🔴 **A duplicate merge STRANDS the desk validation on the retired row.** The links move; the
  `validation_status` does not — so the surviving row sits `pending` and is invisible in every
  dropdown. Repair it with hand SQL, not code.
  `a-duplicate-merge-strands-the-desk-validation-on-the-retired-row`
- 🔴 **The screen that SHOWS a badge is not the screen a rep can OPEN.** The portal Customer
  **Database** is Super Admin + SFE only — a 403 for the medical reps — while the capture path is
  `/validation`. Check the gate before wiring any `actionUrl`.
  `the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open`

## 5. Session, worktree, and parallel-work safety

Before editing, run `git status`, `git branch --show-current`, `git log -1 --oneline`,
`git worktree list`.

- Use one working tree per active session. **Never two interactive sessions in one folder** — the SessionStart lock warning is a hard stop, not advice. (A crashed session's lock self-expires after 2 hours; a lock whose PID is not a running process is stale.) A parallel session can `git checkout` a different branch in a shared tree while you are mid-edit.
- Start new work from the latest `origin/main` on a focused `codex/<task>` branch unless told otherwise.
- Never run `git clone`, `git init`, or anything that recreates the primary repository's `.git`.
- Never discard, overwrite, clean, reset, or revert changes you did not create. Treat unexpected changes as the owner's work. If the tree is dirty, classify and preserve it; continue only when your work can be isolated safely.
- **Never delete a `.xlsx` or `.pdf` file**, even a stray untracked one in a broken worktree being cleaned up. Scan any folder for them before removing it; if found and not identical to a git-tracked copy, move them into an `xlsx/` folder at the repo root instead.
- **Start a session with `node scripts/new-session.mjs <task>` — one command for the whole four-step ritual** ([scripts/new-session.mjs](scripts/new-session.mjs), also wired as `pnpm run session:new`; invoke `node` directly per §2.1): fetch `origin/main`, create `_wt-<task>` on `codex/<task>`, junction `node_modules` from the primary, copy the gitignored env files. It refuses to start below 6 GB of free commit charge. `--status` prints live headroom and which folders can actually run, `--repair` fixes a worktree missing either piece, `--from <ref>` branches from something other than `origin/main`. **`git worktree add` is only step one of four** — it never copies gitignored files, so a hand-made worktree has no `.env.local` (dev-auth and the dev server then fail silently, with no error) and no `node_modules` (nothing runs at all). By hand that is `git worktree add` **plus** `pnpm run worktree:sync-env` **plus** the junction. On 2026-08-26 every sibling worktree was in exactly that state — zero `node_modules`, two with no `.env.local` — so no session could run a test, a script, or a dev server anywhere but the primary, which is precisely how the collisions in this section happen.
- **Never `pnpm install` inside a worktree, and never `pnpm run` there.** The install duplicates ~1.9M path entries (see the payload note below), and `pnpm run` purges `node_modules` outright once it sees the lockfile has moved — destroying the junction before your script starts. Junction `node_modules` from the primary and invoke `node scripts/…` directly. That junction is enough for `typecheck`, `lint` and `node scripts/…`, but **not for `next dev`** — Turbopack reads it as a symlink out of the project root and refuses to start (§2.1, Worktrees).
- Prefer worktrees as siblings (`git worktree add ../_wt-<task>`). If one must live inside the repo, its folder name must start with `_wt-` (or sit under `.codex-worktrees/` or `.claude/worktrees/`) — `tsconfig.json`, `eslint.config.mjs`, and `.gitignore` exclude those patterns, and a folder that matches none of them silently makes every local `typecheck`/`lint` several times slower (confirmed ~12x file count, 70s vs 8s). Locked worktrees under `.claude/worktrees/` belong to other live sessions — never remove them.
- **Remove worktrees with `node scripts/new-session.mjs --remove <task>`** (`pnpm run session:remove`), only after approval. It runs three gates in cost order before touching anything — untracked `.xlsx`/`.pdf` rescue scan, then uncommitted work, then commits that are on no remote branch **and** have no merged PR — drops the `node_modules` junction with `cmd /c rmdir` so no husk is left, and re-reads the folder's branch live rather than trusting an earlier scan (a parallel session can repoint a tree first). **A squash-merged branch legitimately holds commits `main` does not**, so the last gate asks `gh pr list --head <branch> --state merged`, never reachability: pure reachability calls every successfully merged worktree stranded, and the advice that follows from it — "push the branch" — is how you get a conflicting PR that runs no CI at all. By hand it is `git worktree remove` plus that same PR check; `git branch --merged` is always wrong here. Stale worktrees must not accumulate — 26 folders was the historical failure mode.
- **`git worktree remove` leaves a HUSK, and nothing built into git can see it.** It deletes tracked files and the registry entry but leaves the gitignored payload — `node_modules/` and `.next/` — on disk. What remains has no `.git` file and no registry entry, so `git worktree prune` cannot find it and the SessionEnd leg of `.claude/hooks/worktree-exit-guard.mjs` exits early because `git rev-parse --git-dir` resolves nothing. Husks therefore accumulate forever and are invisible to every "list the worktrees" check. **The backup check no longer depends on that leg:** since 2026-08-23 `bash-guard.mjs` hands any removal-shaped command to `worktree-exit-guard.mjs --pre-removal`, which reports unpushed commits and uncommitted files and writes them to `.claude/worktree-exit.log` *before* the directory is deleted. It never blocks. The SessionEnd leg had been silent for a full day while three worktree sessions ended, with the hook still registered and the script still on disk — silence was its only symptom. **Run `pnpm run repo:doctor`** ([scripts/repo-doctor.mjs](scripts/repo-doctor.mjs)) after any removal: it reports by default, `--fix` deletes only husks proven to hold zero files, and it refuses to act while more than one Claude Code session is live. Anything holding even one file is reported NEEDS REVIEW and never touched.
- **A memory file with no index line is invisible, not merely hard to find** — only `MEMORY.md` loads automatically, so nothing recalls an unlinked file and the next session re-derives what it already knows. A sweep on 2026-08-19 found **194 of 734** in that state, the oldest unlinked since May. `pnpm run repo:doctor` now reports them (and pointers whose file is gone) in a MEMORY INDEX section; `--deep` lists every one instead of the first 20. It is read-only and never changes the exit code — deciding whether an orphan earns a line in `MEMORY.md`, a line in `MEMORY-ARCHIVE.md`, or retirement is a judgement about what is still true.
- **Worktree payload — not git, not tsc — is what makes this checkout feel slow.** Measured 2026-08-04: **1,887,882 file paths, 67s to walk**, against 4,107 tracked files — a 460x amplification, ~99% of it worktrees. Tools honouring `.gitignore` never see it, which is why validation looks healthy while the session crawls; what pays is agent file search, `grep -r`, `dir /s`, naive watchers. **Do not tune `tsconfig`/`eslint` for this — those excludes are already correct.** Retire merged worktrees and clear husks instead. Cost is path COUNT, not gigabytes (pnpm hardlinks).

**Machine limits (RAM is soldered at 16 GB — it cannot be upgraded; the pagefile is not).** One dev
server at a time, ever. One typecheck/build at a time locally; parallel validation belongs to CI.

**The binding limit is the Windows COMMIT charge, not RAM — and it is not a constant.** "Keep total
local sessions at **4 or fewer**" was written against a ~19.79 GB commit limit (15.79 GB RAM + a
4 GB pagefile). The pagefile went to a fixed 16 GB on 2026-08-25 (limit **31.79 GB**) and was
re-pinned on 2026-08-26 to **32768/65536 MB — a range, not a size.** The limit is therefore
`RAM + the pagefile as currently ALLOCATED`, verified 2026-08-26 at exactly 15.79 + 32.00 =
**47.79 GB**, and it **floats up to ~79.79 GB** as Windows grows that file under pressure, with
nothing having been changed. So **47.79 GB is the FLOOR, not the ceiling** — never treat a bigger
number as a reset (§2.1), and never budget headroom against a limit you did not just read.
Measured live that evening at 9 sessions, 22.96 GB committed, **24.83 GB free**. That makes the old
"4 or fewer" guidance roughly 28 GB too conservative: **sessions were never the ceiling.**
Separating the MAIN `claude.exe` from
its renderer/gpu/utility children puts an idle session at **~0.5 GB**, while a dev server, build or
cold typecheck is **~3.5 GB** — so the real limit is about 5 concurrent HEAVY jobs, not a session
count. `node scripts/new-session.mjs --status` prints both live. Commit is still finite and the
failure mode is a total freeze, so watch the
**headroom** rather than a fixed session count: `Win32_OperatingSystem.TotalVirtualMemorySize` is the
limit and `FreeVirtualMemory` the headroom, both in KB. **Read them live before quoting any session
number.** Why such a freeze leaves no crash dump, and why `VirtualSize` misleads: §2.1.

Route work by tier:

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

**CI is the gate. Do not run a local full validation.**

`check:harden` was retired on 2026-08-18 at the owner's instruction, along with the
`ask-before-validation` hook and the "ask before you validate" rule that surrounded it. Do not
reintroduce any of them, and do not invent a replacement — no "quick subset" of lint + typecheck
before pushing, no running `pnpm run ci` as a pre-push ritual. **Push the branch and let the PR's
checks answer.**

This is safe because the local gate never gated anything. `.github/workflows/ci.yml` re-lists every
step itself, and the four **required** status checks — `validate`, `lint`, `typecheck`,
`secret-scan` — run on the PR head commit and block the merge if any is red. That is unchanged.
What is gone is only the duplicate local run, which on a 16 GB laptop already carrying several
sessions cost minutes, saturated RAM, and proved something CI was about to prove anyway.

`pnpm run ci` still exists and still runs the whole thing, for the rare case where you genuinely
need the answer before pushing. It is opt-in: run it **only when the owner names it**.

Two things are NOT covered by a PR's CI and still need a check immediately before the action:
**migrations** and **production deploys**. Run what the tier table below calls for in those cases.

Verifying a UI change in the browser is not validation at all — reload and look. That is seconds,
and it is how defects actually get found.

**What must be satisfied before a change is called ready.** Read the right-hand column as *what has
to have passed*, not as *what you should run locally* — for everything except the last two rows, CI
is what runs it, on the PR.

| Change type | Minimum validation | Who runs it |
| --- | --- | --- |
| Docs or repo instructions only | Review diff, formatting, links, secret exposure | You, by reading |
| Narrow TypeScript/JavaScript change | Lint, typecheck, targeted tests | CI, on the PR |
| Shared runtime, app/API route, server component, env, or deployment behavior | Lint, typecheck, tests, build | CI, on the PR |
| UI workflow | Relevant code checks plus browser verification at desktop and mobile sizes | CI for the code; **you** for the browser |
| Migration, view, function, RPC, grant, or policy | Migration checks, SQL review, target confirmation, schema/security review, staging verification after approval | **You, before the migration** — CI never sees this |
| Auth, RLS, payroll, HR lifecycle, sales, permissions, executive reporting | Full checks, role-based tests, failure-state checks, explicit risk review | CI for the code; **you** for the role sweep and the risk review |

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
SHA). A live staging app now exists too (`https://phoenix-people-workforce-staging.up.railway.app`,
§3) — use it to smoke-test before a risky production deploy when there's time. After a
runtime-impacting production deploy, verify the public domain, smoke-test the changed workflow, and
inspect production logs (`railway logs`). When a page fails, capture the visible error, browser
console, network/API response, deployment logs, and database/RLS evidence before proposing a fix.

## 8. Supabase and data safety

- **Supabase writes are pre-authorized end to end — NO approval prompt** (owner's `autoMode` grant in `~/.claude/settings.json`, applied by hand 2026-08-02, which deliberately removes the §6 gate for Supabase). It covers the `supabase-staging` and `supabase-production` MCP servers, the owner's connector `mcp__45bb6356-…`, and the `supabase` CLI (`supabase` / `npx` / `pnpm` / `pnpm dlx`, incl. `db push`), on staging AND production (`ozucdzovmcqvepbozvqf`) — every read tool and every write tool: `execute_sql` mutations, `apply_migration`, bulk and destructive SQL. **You do NOT wait for a separate approval.** The one standing condition: **announce any destructive or bulk PRODUCTION change (it can mutate real payroll data) in plain words before you run it, and give the owner a chance to stop it** — the removed prompt is a UI gate, not licence to skip telling him. (This grant does NOT cover creating/deleting a project or reading secrets — see §6.) `mcp__b345e47e-…` stays denied.
- All schema changes must be migration-based, repeatable, reviewable, and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref, resolving it with `list_projects` rather than trusting a ref pasted in a prompt or copied from an older doc — this line once named a long-deleted staging project, so "verify the ref" confirmed a dead value and the obvious recovery pointed at production.
- Both Supabase MCP servers (`supabase-staging`, `supabase-production`) can see **every project the account is entitled to — all four in the §3 table, not just the two that belong to this app**. **The server name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.**
- Prefer those two named servers for all routine work. Any UUID-named Supabase tool (a claude.ai account connector) has an identity you cannot verify from its name alone, so it stays deny-listed by default — never call an unrecognized one, and flag it if it reappears. `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087__*` remains denied.
- **Owner-confirmed exception (2026-08-02):** `mcp__45bb6356-8105-4482-9464-25bfd754baec__*` is the owner's own claude.ai Supabase connector. He confirmed ownership and instructed its removal from the deny list, so it is callable. **VERIFIED 2026-08-23: it is back IN that list, so the previous sentence no longer describes live state.** `permissions.deny` in `~/.claude/settings.json` currently holds **two** entries — `mcp__b345e47e-…` *and* this connector — and a `deny` is a silent hard block rather than a prompt, so a session following the sentence above hits a wall with no dialog to explain it. **OWNER DECISION 2026-08-23: leave it DENIED.** He was asked directly and answered plainly, so this is settled — the connector stays in `permissions.deny`. Do not re-allow it, do not propose re-allowing it, and do not read a blocked call as a bug to chase. Nothing is lost by the block: the two named servers in §3 cover routine work, and this connector's grant was always the broader, riskier one. Note its consent grant is **broader than either named server** — read+write on Secrets, Environment, and Projects, meaning it can read project secrets and create or delete projects. Reach for the named servers first; use this one only when it is actually the right tool. Its DB writes fall under the pre-authorized grant above (announce destructive/bulk prod changes; no wait), but **creating/deleting a project or reading secrets is NOT covered — get an explicit go for those** (see §6).
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
