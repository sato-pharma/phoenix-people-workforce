# Phoenix Workforce — Agent Rules

Operating rules for every AI agent and automation tool in this repository. Codebase reference
(layout, auth, API conventions, cron, env) lives in [docs/architecture.md](docs/architecture.md);
daily commands and the protected-file gate live in [CLAUDE.md](CLAUDE.md). Higher-priority platform
or system instructions take precedence. When instructions conflict or scope is unclear, stop before
the risky action and explain the conflict plainly.

**This file auto-loads in full on every request. Every byte here is paid for on every turn.** So it
holds **hooks only** — a hook is the rule, never the evidence. The measurements, dates, PR numbers
and incident narratives behind each one live in `docs/`, read on demand. **Adding a rule? Put the
hook here and the account in `docs/` — never the account here.** §2.1 and §4 grew to 26KB and 24KB
of essays once already, at a measured cost of roughly 13,000 tokens of context on every request; the
2026-09-01 consolidation moved that back into `docs/` where it belongs.

**Memory slugs live in [docs/agents-memory-map.md](docs/agents-memory-map.md), not here — except the
ones that map marks `(inline — load-bearing)`.** `scripts/memory-index-reachability.mjs` scans
`AGENTS.md` only, never `docs/`, and matches the **backticked** form, so a slug removed from here
orphans that memory **unless `MEMORY.md` also links it**. Those marked slugs are the ones that depend
on this file; the rest moved out on 2026-09-01 (6,921 bytes off every request). **The map is the
authority — re-run the classifier before removing any slug**, since which are load-bearing changes as
the index does.

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
- **Almost nothing prompts** (see rule 1.5) — you are the last line of defense.

He writes short, terse instructions and expects you to work out the scope. Explain like a smart
non-engineer: what happened, what it costs, what to do next.

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
4. **After compaction or a long session, distrust yourself.** A replayed summary of earlier work can
   read like a live instruction. Before acting on "previous" state, re-run the check. Prefer one
   fresh session per task over one endless session.
5. **The absence of a permission prompt is not approval.** `permissions.defaultMode` is **`default`**
   in user-level `~/.claude/settings.json` (changed from `auto` 2026-08-31, so a would-be block
   becomes a prompt). But `permissions.ask` in `.claude/settings.json` is **empty** — no dialog fires
   from a prompt rule at all — and several hundred allow rules wave routine calls straight through.
   `permissions.deny` holds only silent hard blocks, not prompts. **Every approval rule in §6 is
   therefore behavioral: ask in plain words and wait for a plain answer.** Never offer a prompt that
   did not appear as evidence you were allowed, and read the settings file before asserting what is
   enforced. Full history: [docs/agents-incident-history.md](docs/agents-incident-history.md).

## 2. Hard-Learned Rules (each cost a real incident — do not relearn them)

Evidence — dates, PR numbers, billing figures, measurements — is in
[docs/agents-incident-history.md](docs/agents-incident-history.md). Read it before changing branch
protection, CI cost, the deploy path, or the region.

- **Never use `gh pr merge --auto`.** `main` is branch-protected (`enforce_admins: true`) with **4 required status checks** — `validate`, `lint`, `typecheck`, `secret-scan` — that **DO gate every merge**. `allow_auto_merge: false`, so `--auto` is rejected anyway. Required reviews is **0**. Merge only with an explicit plain `gh pr merge` after separate owner approval.
- **Do NOT run `gh pr update-branch` reflexively.** "Require branches up to date" is **OFF** (`strict: false`, owner-approved 2026-08-05) because it was the dominant Actions cost and hit the spending cap. Each run costs ~16 Actions minutes and discards the prior green CI. Run it **only when the change genuinely depends on something newly on `main`**.
- **When you do run it, it acts on the SERVER — your local branch is then stale.** The next `git push` is rejected with *"remote contains work that you do not have locally"*. Always `git fetch` and `git merge --ff-only origin/<branch>` first. It also moves the head SHA, so **CI re-runs and the previous green result no longer applies.**
- **A merge to `main` SHIPS TO PRODUCTION IMMEDIATELY.** Railway deploys on push, at full traffic, no cron wait, no staged rollout, no smoke test. **Never merge anything to `main` you are not willing to have serving employees within minutes.** To confirm what is live, request `/api/healthz` and read `revision`.
- **There is a staging application again**, wired to the staging Supabase project — URL and caveats in §3.
- **A local typecheck must not trust a warm TypeScript cache.** CI always starts cold. If you must run one by hand, use `tsc --incremental false`.
- **Never foreground-watch a long pipeline.** Background it and check at batched checkpoints.
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), not the cookie flow — cookie switching logs the real user out.
- **Merged-branch checks must be squash-aware.** Use `gh pr list --head <branch> --state merged`; `git branch --merged` is always wrong here.
- **A regression test only counts if you break the fix and confirm the new test's own headline assertion fires.** "The suite went red" is not proof.
- **`list_migrations` reports the ledger, not reality.** To prove an object exists, query `pg_class`/`pg_proc`.
- **Auto-git workflows are permanently banned.** Tried and reverted **twice**. Always ask first.

### 2.1 Session-level traps

**Each line is a cue, not the fact.** The account of every one — measurements, dates, PR numbers,
the diagnosis traps — is in **[docs/agents-session-traps.md](docs/agents-session-traps.md)**; search
it for the hook's wording. Which memory backs which hook:
[docs/agents-memory-map.md](docs/agents-memory-map.md).

**Shell and tooling**

- **`grep -r` hangs on this checkout — use `git grep` or `rg`.**
- **MSYS mangles paths silently, three ways:** `git show <ref>:<path>` returns EMPTY; `grep -c $'\r'` matches EVERY line of a pure-LF file; and a `git grep`/`rg` PATTERN holding a leading-slash path matches NOTHING — 41 hits read as 0, i.e. *the code is clean*. Export `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` first; never quote a count without it.
- **`TZ=Africa/Cairo date` silently returns UTC in MSYS — 3h early, no error**, so recent work reads as old. The tell is a Cairo reading at `+0000`; the clock is ALREADY `+0300`, so use plain `date` or node, never `TZ=`. `tz-africa-cairo-silently-returns-utc-in-msys`
- **A role probe cannot trust the HTTP status code**, and **a POST to ANY `/api/**` path returns 403 even when the route does not exist** — probe with GET.
- **`curl -d "@-"` creates NOTHING on Windows** — write the JSON to a file, pass `-d @file.json`.
- **Reads of `.env*` are auto-approved deliberately, for EVERY key** — licence to inspect, never to propagate. Do not re-litigate or narrow it.
- **A permission allow-rule stores the LITERAL command, so an inline env var bakes a live credential into `settings.local.json` in plaintext.** Grep `settings.*.json` for `TOKEN=`/`KEY=`/`SECRET=` before sharing or merging.
- **`mcp__supabase-staging__*` is broken** — route staging work through `mcp__supabase-production__*` passing the staging `project_id`.
- **The Supabase MCP returns ONLY the last result set of a multi-statement `execute_sql`** — earlier ones vanish with no error, so a block that verifies in statement one and summarizes in two certifies a check you never saw. One question per call.
- **A Windows USER env var SHADOWS every `.env.local`, silently.** Re-probe all three; never print the value.
- **The local attendance agent dies at EVERY logon and loses NOTHING — do not escalate it.** Never disable the 2-hourly task, never launch a second agent (it can fire a PRODUCTION sync).
- **ExcelJS emits two schema-invalid OOXML fragments, so Excel silently REPAIRS the workbook** — both need the `.xlsx` zip post-processed.

**Git**

- **Deleting a branch does not remove its pushed commit**, and **reusing a squash-merged branch makes a conflicting PR.**
- **`git push` hangs — kill at ~60s and retry.** The OOM was a 500MB `http.postBuffer`, now 8MB; do NOT restore it.
- **A merge to `main` mid-session silently orphans your next push.**
- **`refs/deleted-*` is NOT automatic — a plain `git branch -D` archives NOTHING.** Keep the SHA the delete prints; archive with `git update-ref` *before* deleting. `refs/backups/*` on ORIGIN is the only copy that survives losing this laptop.
- **An empty `git log <branch> --not --remotes=origin` is NOT proof a branch is safe to delete** — `git fetch` never prunes, so the check compares the branch against itself. Gate deletion on the merged PR.
- **A UTC merge time read against a Cairo commit time INVERTS the merged/stranded verdict.** The answer is CONTENT (`git patch-id --stable`), never a timestamp.
- **`git` "Authentication failed" can be the credential HELPER going OOM, not a bad token** — change NO credentials.
- **`F:\PHX backup` is the disaster-recovery set, and a bundle restore silently returns ZERO refs without `core.longpaths`.** Three of its sections hold LIVE keys.

**CI and PRs**

- **CI jobs failing in SECONDS mean billing, not code.**
- **`secret-scan` is a required check — there are 4 — and it is the one that never runs on a `main` push.** Its absence from a merge commit is CORRECT.
- **`gh pr checks` LAGS behind the real job state.**
- **`check-runs: 0` also means CONFLICTED** — a conflicted PR runs no CI at all, which reads as "not started".
- **ONE new hub page trips FOUR separate CI gates.**
- **A red `main` still builds, ships and serves perfectly**, and a green PR is not a green `main` — after merging, check the run on `main`'s NEW head.
- **A docs-only PR's `validate` runs NO tests — it skips the expensive steps, ~10s.** The fast path is `pull_request`-ONLY, so the suite's FIRST run is the push to `main` — production's branch. Three PRs shipped `main` red this way; a `validate` under ~30s is the tell.
- **Runs NEVER CREATED is an Actions OUTAGE, not billing** — billing creates the run and fails it in seconds. Check githubstatus BEFORE touching the spending limit. A `workflow_dispatch` run never enters a PR's `statusCheckRollup`.
- **Recover a PR with `gh run rerun <id>` on its OWN `pull_request`-sourced run** — it keeps the `event`, so its checks DO reach the rollup. Then WAIT: dispatch lags 20–30 MINUTES during an outage and events are NOT dropped. Fire ONE recovery event and leave it.
- **An extra SHA does not merely waste a run — it ACTIVELY KILLS the real head's**, because `ci.yml`'s concurrency group is the same for every commit on a PR. Never push an empty commit to force a `synchronize`.
- **`actions/runs?head_sha=` needs the FULL 40-char SHA** — an abbreviated one returns `total=0` with no error.
- **A push to `main` during an outage ships to PRODUCTION with no CI run at all.** Recover with `gh workflow run ci.yml --ref main`.
- **The GitHub repo is `phoenix-people-workforce`; the FOLDER, npm package, `supabase/config.toml` and dead GCP project are all `phoenix-workforce`.** A path built from the checkout name 404s, which reads as *the deploy never happened*. `gh repo view --json nameWithOwner` settles it.

**Migrations**

- **A migration FILE written is not a migration APPLIED**, and **a merged migration file does not mean the grants are live.**
- **Migration timestamps COLLIDE across parallel branches**, and **the ledger version never matches the filename.**
- **A PostgREST `.in()` carrying several hundred ids returns ZERO rows and NO error.** Chunk at ~50 and print the intermediate count.
- **A `neq` against an ABSENT jsonb key matches ZERO rows**, and **an unbounded `.select()` stops at 1000** with no marker. Write the OR-form; `count(*)` before trusting any select, then page with an explicit `.order()`.
- **`n_live_tup` is STALE in production — it reports LIVE tables as empty.** Sweep with a real `count(*)` via `query_to_xml`.
- **A Supabase client request that times out at 15s STILL COMMITS**, leaving a half-applied state with no audit row. Do heavy multi-step mutations in ONE `plpgsql` function.
- **A missing TABLE answers `PGRST205`, NOT `42P01`** — so the obvious guard fires never and the deploy-before-migration window 500s a whole page. Treat both codes as one set behind one helper. `a-missing-table-answers-pgrst205-not-42p01`

**Database, grants and RLS**

- **A write REVOKE does NOT make a table read-only** — `ON DELETE CASCADE` and `SECURITY DEFINER` both run as the table OWNER, and `has_table_privilege` sees neither bypass. Fixed on prod; **do not redo or undo.**
- **An append-only table needs a STATEMENT-level `BEFORE TRUNCATE` trigger** — `TRUNCATE` fires no ROW triggers, and a revoke never binds the OWNER. Prove all three verbs are refused.
- **RLS on with no `authenticated` grant is the NORM here — 222 of 308 tables — not a defect class to sweep.**
- **ONE `auth.users` row with `banned_until = 'infinity'` 500s the ENTIRE GoTrue admin API** — page-shaped, so a small `per_page` probe passes. Retire with the app's finite `876000h`.
- **`au.f_monthly_achievement` SERVES A PRECOMPUTED ROLLUP, and its fingerprint covers the CONFIG surface — NOT the sales data.** So repairing an import or rollup row changes NOTHING on Sales vs Target or its five siblings — no error, no staleness marker, the old number just keeps coming. Run `au.f_refresh_monthly_attribution(period)` after ANY sales-row repair, diffing stored against live first so the refresh is a check, not a hope. `attribution-rollup-fingerprint-ignores-the-sales-data`
- **The ATS data model carries four traps that each read as normal.** The offer chain was live in the registry with a HOLE past `approved_at`; the `ats_candidate_*` children have NO FK and one is a VIEW; a CV RE-READ never wrote what it read (`applied_fields` is NOT the writer); and `medical_rep` reads 12 fields where `universal` reads 38. **NEVER raw-SQL `national_id`/`email`/`phone`** — the `_norm` dedupe index is app-maintained. `offer-chain-was-live-in-the-registry-with-a-hole-past-approval` · `ats-candidate-children-one-has-no-fk-and-one-is-a-view` · `cv-extraction-reads-governorate-but-never-applies-it` · `the-medical-rep-cv-schema-reads-12-fields-universal-reads-38`
- **A CV import OVERWROTE a candidate's whole identity — detect it with a per-candidate SENDER COUNT, where healthy is 1.** The allowlist holds an INBOX, not a sender, so never resolve a CV by sender; and the CV file lives in `ats_files`, NOT `cv_external_url`, which is empty for EVERY candidate and reads `NO FILE`. `a-cv-import-overwrote-a-candidates-whole-identity` · `the-email-import-allowlist-holds-an-inbox-not-a-sender` · `cv-file-is-in-ats-files-not-cv-external-url`

**Probing, attributing and reporting production**

- **A 200 from a health endpoint can be blind to the thing that is broken** — OpenAI's `/v1/models` certifies a key with no balance. The BILL cannot be read from the API at all.
- **`app_error_events` returning 0 rows means QUIET, not broken.** Prove the route with 405 against a 404 control; never POST a synthetic error to production.
- **The Error Monitor HIDES rows whose `environment` is NULL**, and a `create table … as select` copies rows but never RLS — **measure the new table's ACL, never assume it either way.**
- **`updated_by_hr_id` LIES about who wrote a row.**
- **HR ids are MIXED CASE, so a plain `.eq` silently under-returns** — one `.eq` hid 28% of reps' own orders, and on `au.occupancy_history` the loss is TOTAL (0 of 120 join), where a row matching nobody reads as *a vacant seat* rather than a bug. Lower BOTH sides.
- **The Sato logo's wordmark is WHITE, so "SATO" vanishes on white paper.**

**Validation**

- **A repo-wide pattern sweep must grep the TESTS for the old string too — a pinning test can pin the ANTI-pattern.** `runTest` rethrows, so a loop over N routes reports only the FIRST. Run `git grep -l '<the exact old line>' -- tests` first.
- **A test name appended beside an existing one in `tests/run-tests.ts` becomes an ARGUMENT, not a registration.** One `await runTest(name, fn)` per test; check by AST.
- **`node --test <file>` on this repo's suites passes VACUOUSLY** — each is an exported function registered in `tests/run-tests.ts`, so a file with no `test()` call reports `pass 1` for merely IMPORTING. It reported pass on a check deliberately broken. Call the exported function, and prove RED before quoting a local green.
- **RAM-saturated? WAIT — do not skip validation for it.**
- **Source-pinning tests slice a fixed BYTE window and false-FAIL** when the file shifts.
- **A heredoc eats backslashes** and yields a test that only ever passes.
- **`parseDiagnostics` is SYNTAX-ONLY — it cannot see a typecheck error.**
- **`setState` inside `useEffect` is a lint ERROR here.**
- **A green TEST run carries NO type signal** — `pnpm run test` strips types. Only the PR's `typecheck` job answers.
- **The SUITE runs with PRODUCTION credentials while a test sets `APP_ENV=production`**, so any module writing on `isProductionRuntime()` writes to PROD from `pnpm run test`. Gate such a write on `PHOENIX_TEST_SUITE`. `the-test-suite-runs-with-production-credentials-and-app-env-production`
- **A test can NEVER hand a function a `process.env` literal** — both spellings fail, and each error only surfaces once you have fixed the other.
- **An exhaustive `Record` does NOT gate the build** — `ignoreBuildErrors` lets a missing key compile, build and DEPLOY. Back it with a RUNTIME assertion in a registered test.
- **A narrowed SELECT disarms every gate downstream of it** — test the SELECT, not the branch.
- **An OPTIONAL field written UNCONDITIONALLY is a silent erase.** The PATTERN regenerates, not the two fixed call sites.
- **A feature can ship green, deploy cleanly, and be reachable by NOBODY — and zero usage is what both look like.** Exercise the path end to end before concluding it is adoption.
- **A merged fix on a path nobody has exercised is untested, not proven.**
- **`cn()` SILENTLY DROPPED every `text-phx-*` size, and only `getComputedStyle` in a real browser can see it.** The literal `text-[13px]` form was always safe: **the rename to a named size is what creates the bug.** `tailwind-merge-strips-custom-named-font-sizes`
- **Arabic + English in ONE value needs direction PER LINE; `dir="auto"` on the block is the WRONG fix** — `auto` reads only the FIRST strong character, so the ENGLISH half renders backwards, the exact mirror of the bug. SINGLE-language free text is the opposite case: block-level `dir="auto"` is correct there, and house style. Measure production for Arabic before "fixing" a screen. `bilingual-bodies-need-direction-per-line-not-per-block`
- **`@/lib/utils` resolves to the ROOT `lib/utils.ts`, NOT `src/lib/utils.ts`** — editing the `src/` copy changes nothing, with no error. `at-slash-lib-shadows-src-lib-via-tsconfig-paths`

**Memory and this index**

- **Sweep memories by CLAIM, never by filename or topic**, and never rewrite a dated record.

**Parallel sessions**

- **A parallel session can collide with NO git trace at all** — `gh pr list`, `git log` and `git worktree list` were all clean while another session edited the same file. Read the SessionStart working-tree line as a collision signal. A stale lock proves the PID is dead, not that the folder is unattended. Resolve by MERGING, never discarding.
- **ONE approval can reach SEVERAL sessions — N sessions holding the same "yes" is N executions.** Before executing a protected action on a terse approval, check how many sessions are live, say so, and re-verify the target immediately before acting. `mergedBy` naming the owner is NOT evidence of a human click.

**Worktrees** (see also §5)

- **Another SESSION can remove a worktree under you.**
- **A gitignored `_wt-*/` scratch folder makes a worktree look clean.**
- **The pre-push gate is GONE — a bare worktree pushes fine.** What it cannot do is RUN a suite.
- **`--fix` needs exactly ONE live session; `--strip-idle` does NOT** — it gates per worktree on dirty/unpushed/120-min-idle behind a lock, so RUN it with sessions open; the old census meant it never once ran. **`--fix` clears a husk only if it holds ZERO files, and can still FAIL on a locked one** — then use `rmdir /s /q` from PowerShell, not Bash.
- **repo-doctor's RETIRABLE verdict names the branch a folder HAD at scan time.** Treat any scan older than the current command as fiction — re-read at the moment of removal.
- **Every retirement gate can PASS on a worktree in active use** — nothing catches a live PROCESS. Two signals see what the gates cannot: the newest mtime under `.next/`, and HEAD moving between the gate read and the removal. Read the tip at the GATE and reuse that SHA.
- **Closing the session does NOT release its worktree, and the release is not INSTANT.** `git worktree remove` then fails *Permission denied*, deregisters anyway, and leaves the husk. **Nothing points at the holder** — a `Win32_Process` sweep, a `ParentProcessId` sweep and the Restart Manager API all report NOTHING, because a working-directory reference is not a file handle. **QUIET TIME frees it, not force.** `git fsmonitor--daemon` — spawned by ANY `git -C <worktree>`, **your own read-only gate scans included** — outlives the session, but is NOT the mechanism: the lock held with ZERO git processes running, then cleared on the FIRST `rmdir /s /q` after 300s of **not touching the folder**. Stop scanning it and retry every few minutes. **NEVER kill git machine-wide on a loop** — `Get-Process git | Stop-Process` hits every session, and a parallel one is usually live.
- **A squash-merged branch reads as "on NO origin ref" — that means BACKED UP, not stranded.** Never push a merged branch to "rescue" it; `git branch rescue/<name> <tip>` is the zero-risk move.
- **Self-removing a worktree MUTES its own session-end guard — and a `.claude/worktrees/` one canNOT retire itself at all.** `ExitWorktree` no-ops on any worktree it did not create in THAT session, and `change_directory` refuses to move a session pinned to one ("runs in an isolated worktree"), so the session's own cwd holds the folder and `git worktree remove` deregisters-then-husks every time. **So strip the payload FIRST, while you still can**: drop the junction with cmd's NON-recursive `rmdir` (never `Remove-Item -Recurse`, which can follow it into the primary), then `.next`. The husk then holds ZERO files — the only state `--fix` above will clear. Do it in the other order and the husk keeps its payload, and only quiet time and a hand `rmdir /s /q` will shift it.
- **`next dev` in a worktree needs the explicit `--webpack` flag** — TURBOPACK rejects the §5 junction, not Next; `pnpm run dev` now chooses for you (`scripts/dev-server.mjs`). **The watchdog's 6 GB kills are NOT a bundler trait** — SEVEN webpack servers died at the same ceiling. It is a watchdog-THRESHOLD problem: this server legitimately reaches ~6 GB, made acute by two servers at once, and `--max-old-space-size` is a measured no-op because the growth is off-heap.

**Next.js runtime**

- **A >2MB `unstable_cache` entry KILLS the dev server** — throws only in dev, uncatchable, muted in prod.
- **`unstable_cache` SERIALIZES, so a returned `Map` comes back `{}`** — the page works on exactly ONE render, then throws for the whole revalidate window, rendered as the admin error boundary (which reads as a permission redirect). Cache the ROWS.
- **Standalone tracing copies FILES, not pnpm SYMLINKS**, and **a top-level `import sharp` 500s a whole PAGE** when the `.so` is missing.

**Browser and dev-auth**

- **A MINIMIZED window makes every browser reading LIE — check `document.visibilityState` FIRST.** rAF stops entirely, so **dnd-kit cannot run at all** while plain `.click()` still works. `javascript_tool` does not await a returned promise, and the isolated world cannot see React fibers.
- **Click by TEXT — blind coordinate clicks once fired a real production collection run.**
- **Dev login is `GET /api/dev-auth?role=<Role>`, and it DOES role-switch the Browser pane** via an httpOnly cookie. **It DOES take `hrId`** — `?role=National%20Sales%20Manager&hrId=a-12&next=<path>` signs you in as THAT person, the only way to verify anything scoped to one manager's team. **Header-only is the SEPARATE `x-phoenix-*` path**, which the pane cannot set; that is what role SWEEPS use.
- **Turbopack 500s with `0xc0000142` when the commit charge is exhausted** — close a session, do not debug the code.
- **Verify a 375px mobile layout with NO dev server.**

**Machine ceiling**

- **A freeze leaves NO dump** — an EMPTY Windows Minidump folder is the EXPECTED signature, and the tell is `dwm.exe` dying `0xC00001AD`. The ceiling is COMMIT, not RAM; §5 carries the mechanics and the live-read rule. **Never judge a process by `VirtualSize`.**
- **Two decoys sit on that diagnosis:** `nvlddmkm` is what dies when the compositor is starved, not the cause; but the `node.exe` figures in **Event 2004 ARE real**. The largest leak so far is a throwaway ExcelJS probe (22 → 41 GB in 40s, off-heap). Delete such probes when done.
- **An interrupted session leaves the tree BROKEN ON PURPOSE.** Before acting on a bare "commit it", `git grep BREAK-`.
### 2.2 The memory index

**Each line is a cue.** Why each rule exists, every trim pass with its byte counts, what earns a line,
and the arithmetic behind the budget are in
**[docs/memory-index-budget.md](docs/memory-index-budget.md)**.

- **`MEMORY.md` is the ONLY memory file that auto-loads, and the loader truncates it at 24,400 bytes — SILENTLY.** No error, no marker: the tail simply stops existing, so a hook can be present in the file and absent from every session that reads it.
- **The budget is 22,000 bytes, and the 2,400-byte gap is deliberate slack.** `node scripts/repo-doctor.mjs` prints the verdict and the exact bytes to free; `.claude/hooks/memory-index-guard.mjs` puts the same figures into every session at SessionStart.
- 🔒 **THE DISPLACEMENT RULE — never add an index line without freeing at least as many bytes in the same edit.** The file is append-only in practice, so any "trim it when it gets big" plan loses to the append rate by construction.
- 🔒 **IGNORE the "compact it to under 17.1KB" message.** It fires on EVERY edit to `MEMORY.md`, looks authoritative, and asks for something arithmetically impossible — measured unreachable twice, because the dominant cost is filenames plus `[]()` link syntax, which shrinks ONLY by deleting a memory. Landing under the cliff with real headroom is a SUCCESS.
- **Route by KIND of fact, never by topic** — an agent-operating trap to §2.1, a production or approval hook to §2.3, an owner product rule to §4. **Reach is identical; only scannability differs.**
- **Never delete a hook to make room, and correct the FILE before the hook.** The frontmatter `description` decides whether a memory is recalled at all. A stale hook costs more than a missing one — it gets defended rather than looked up. The floor is structural.
- **What earns a line — all three:** a session would act WRONGLY without it, it is durable (never a count, a status or a date), and it is not derivable in one step. **Sweep by CLAIM, never by filename or topic.**
- **A relocation spanning git and `~/.claude/` must finish BOTH halves or neither, in that order** — the destination must be **merged** before the index line is trimmed. `scripts/memory-index-reachability.mjs` matches a **backticked slug in `AGENTS.md`**, so a hook written on an unmerged branch correctly still reads as an orphan. **Before cutting any section out of this file, check which slugs appear ONLY there** — and note that
since 2026-09-01 most slugs sit in [docs/agents-memory-map.md](docs/agents-memory-map.md) instead, with
only the 18 load-bearing ones inline.
- **No required check can gate any of this.** `MEMORY.md` lives outside the repository, so CI never sees it — the displacement rule is behavioural.

### 2.3 Production and approval hooks

**Each line is the rule, not the evidence.** The account of every one — measurements, dates, incidents,
and the diagnosis traps that nearly sent each the wrong way — is in
**[docs/agents-production-hooks.md](docs/agents-production-hooks.md)**, verbatim.

**Railway deploys**

- **A deploy applies NO migrations**, and **auto-deploy can silently SKIP a race.** A merge that never shipped looks identical to one that did until you read `/api/healthz`.
- **`railway variables --stdin` stores a BOM**, which then travels inside the value.
- **`railway ssh` JOINS argv and lands as ROOT.**
- 🔴 **`railway service source connect` is NOT environment-scoped — `--environment staging` REPOINTED PRODUCTION.** The git source is **service-level**, shared by every environment, so **a branch cannot be staged on Railway without shipping it** — never use it to preview, and §7's staging smoke-test needs a **separate service**. Production silently ROLLS BACK whatever was merged since, and `healthz` reporting `status: ok` hides it — **read the `revision`.**

**Cron and secrets**

- **A PARTIAL `CRON_SECRET` rotation leaves TWO fingerprints**, and Healthchecks reading `up` is **not** proof of authentication — the grace window hides a 401. The past 401s are RESOLVED: **rotate NOTHING.** Always print `len` (the fingerprint is `Bearer …`, 71).
- **`CRON_SECRET` lives in TWO stores and the arrow points GitHub → Railway.** `sync-railway-production-secrets.yml` rewrites ~48 Railway production variables unconditionally, so **rotating in Railway alone does not stick** — the next push reverts it and every cron-job.org job 401s at once. **Rotate GitHub first.** A nightly-failing cron alerts NOBODY; the 4 OFF iReports360 jobs are DELIBERATE.
- **The cron-job.org REST API allows 100 requests per DAY** — 429 on EVERY endpoint with no `Retry-After`, and a bulk edit costs ~34 and CANNOT be rolled back.

**Production data**

- **NEVER rotate the Supabase DB password with `ALTER ROLE`** — Supavisor holds its own copy; use the dashboard only. `28P01` vs `XX000` tells a stale password from a wrong host.
- **`expense_claims` is the ONE live RLS read path in production.** Put a precondition in every production `WHERE` when another session shares the queue, and remember **"Log out everywhere" is THREE writes.**
- 🔴 **Production has NO PITR — 7 daily physical backups are the whole recovery story**, and healthy WAL archiving is not PITR. Granularity is one day and the restore unit is the whole database: say so plainly before any bulk or destructive production change, and **never restore a daily backup in place** — it rolls back everything since roughly 07:30 Cairo that day.
- 🔴 **Payroll NEVER reads `social_insurance_status` — the `social_insurance_wage` column ALONE decides the statutory filing, and NEITHER statutory figure reduces take-home pay.** The status is display-only, so register and filing disagree **both ways, silently** — **audit by querying both columns, never by status.** Both are reported as `governmentalDeductions` yet are **absent from the deductions that feed payable**: the company absorbs them, so setting a wage costs the employee NOTHING. Never warn the owner a wage will cost someone money. `payroll-reads-the-insurance-wage-never-the-status` · `social-insurance-and-tax-never-reduce-take-home-pay`
- 🔴 **A HELD payroll row is DROPPED at publish, silently.** `publishToPayslips` filters `!onHold`: no `salary_record` is written and **nothing records the out-of-system payment**. **HELD = OWED PART 2 ONLY** — paying full net double-pays part 1, so validate part 2 against PUBLISHED rows. `payroll_eligible=false` is NORMAL for executives. Read `hold_reason` and never re-raise. `a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace`

**Which environment the code thinks it is in**

- **A LOCAL run writes PRODUCTION but silently skips every email**, and **the local Resend key CANNOT send.** Send from production with `railway run`.
- **STAGING cannot rehearse a PRODUCTION shape.**
- **`APP_ENV` was UNSET on Railway `staging`, so staging identified itself as PRODUCTION** — `isProductionRuntime()` and `currentEnvironmentLabel()` both read `APP_ENV || VERCEL_ENV || NODE_ENV`, and a Next.js production build sets `NODE_ENV=production` on staging too. **Fixed.**
- **The email fail-safe did NOT cover staging.** `isForceTestingDelivery()` returns `!isProductionRuntime()` when `PHOENIX_EMAIL_FORCE_TESTING` is unset — inverted exactly where it was needed. Staging is safe only because that variable is set explicitly: **one variable, nothing behind it.**
- **The `APP_ENV`/cron-secret hole is CLOSED — do not re-chase it.** **Treat `!isProductionRuntime()` as an auth fallback with suspicion anyway:** it reads as "only in dev" and means "anywhere not labelled production".
- **The `railway` CLI is linked to `production` here**, so every variable command needs an explicit `-e staging`. Omitting it writes to PRODUCTION — and for `APP_ENV=staging` that would redirect **real employee email** into test inboxes. Setting a variable **does** trigger a redeploy (unless `--skip-deploys`), and the change is inert until that deploy reaches `SUCCESS`.
- **That deploy fires in SECONDS but serves in MINUTES — reading the gap as "no deploy" is a mistake already made here.** **Confirm by listing DEPLOYMENTS, never by probing the running app**, and never `railway redeploy` to make a variable "take".

## 3. Stable Environment Facts

**Each line is the fact, not the evidence.** Measurements, dates, PR numbers and incident narratives
are in [docs/agents-incident-history.md](docs/agents-incident-history.md).

- Production application: `https://phoenix-hr.satopharma.com` — **served by Railway, no longer Cloud Run.** Railway service `phoenix-people-workforce`, project `Phoenix-HR-Workforce`, environment **`production`**, region **`europe-west4-drams3a` (Amsterdam)**, 1 replica. **If production is ever re-platformed it must stay in Europe** — colocated with the Frankfurt Supabase project and near the Cairo users. Also at `https://phoenix-people-workforce-production.up.railway.app`; Cloudflare holds `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied.
- **Do not assume "merge to `main` ships to production" — confirm the Railway `production` service source branch first.** It tracks `main` directly, but it has silently drifted before and stranded five merged, green PRs for hours with no signal. `railway status --environment production --json` returns the WHOLE project, so select by `.environments.edges[] | select(.node.name=="production")`, print the name you matched, then read `.node.serviceInstances.edges[].node.latestDeployment.meta.branch`. See §2.3.
- **GCP is DEAD, not standby.** Billing is closed; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`. Do not "verify production" against Cloud Run.
- **The production scheduler is the third-party `cron-job.org`, and it is running, not stalled.** The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** — a red herring. **Never tell the owner notifications/iReports are stalled without checking `cron-job.org` first.** **It cuts every request at 30 s, a PLATFORM cap `requestTimeout` cannot raise — but the server DOES finish the work afterwards**, so a long route logs a false `Failed (timeout)` while succeeding. ⚠ **A MID-SWEEP SNAPSHOT READS EXACTLY LIKE A TRUNCATED ONE** — read the terminal artefact (the audit row, the response body of `GET /jobs/{id}/history/{identifier}`, the final log line), never row timestamps mid-run. `src/lib/cron-control/*` is a dashboard over the dead GCP scheduler and remains inert.
- **The OUTBOX DRAIN is the one that needs care — it ran perfectly and did nothing for 13 days.** **A green cron and a 200 prove nothing here**, and **`attempted: 0` cannot by itself tell idle from broken — read `drainHealth` in the response body.** The head-of-line block is **FIXED** on all three drains, with a dead-man's-switch alarm behind it. **That alert is deliberately never email, and do not "fix" that back** — it fires precisely when the notification pipeline is the thing not delivering. To check the drain, run its own window query — `status in ('pending','failed')` AND `(next_attempt_at is null or next_attempt_at <= now())` ordered by `created_at` **limit 50** — and count how many of those 50 are already exhausted.
- **There IS a live Railway `staging` environment**, same project, service `phoenix-people-workforce`, at `https://phoenix-people-workforce-staging.up.railway.app`. Its service source tracks git branch `main` (not the branch named `staging`), and its `NEXT_PUBLIC_SUPABASE_URL` points at the staging Supabase project — safe as a real verification target.
- Vercel: fully legacy/decommissioned — never deploy to or verify against it.
- **Supabase project refs — the complete list `list_projects` returns.** Two of these four belong to this app; the other two do not, and are listed so an unfamiliar ref is identifiable instead of alarming.

  | Ref | Name | Region | Org | What it is |
  | --- | --- | --- | --- | --- |
  | `ozucdzovmcqvepbozvqf` | Phoenix HR | eu-central-1 | `rovnkzmhokgsruftjsaw` | **PRODUCTION** — real payroll data |
  | `cifwmndunmlxjhyjugxa` | Phoenix-HR-Staging | eu-central-1 | `rovnkzmhokgsruftjsaw` | **STAGING** |
  | `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | `rovnkzmhokgsruftjsaw` | unrelated to this app |
  | `mlbpzvaanusdejqnimst` | the owner's personal project | eu-central-1 | **`xadcyivhxyjtehyheowl`** | unrelated — **different organization** |

  **Dead refs — treat any doc, memory, or prompt still naming one as stale:** `izhmxvgiktiafqusolot` and `oaifhavixhdtwmseshff`. Neither is returned by `list_projects` any more.

  **Neither region nor org is a guard** — three of the four are `eu-central-1`, and both named MCP servers see **all four**. Resolve with `list_projects` before acting (§8).
- GitHub Actions secret `STAGING_SUPABASE_SERVICE_ROLE_KEY`: the staging service-role key, used by `ci.yml`'s login-smoke step and both staging legs of `migration-drift-check.yml`. **There is no `preview-smoke` job** — the smoke test is a step inside `validate`.
- **`.env.local` points at PRODUCTION Supabase.** `pnpm run dev` mutates production data.

Environment meanings — **Local**: this machine or localhost. **Preview**: the deployment generated
for the current branch. **Staging**: a preview connected to the staging Supabase project.
**Production**: the public production domain and production Supabase project.

Never store passwords, tokens, API keys, service-role keys, JWT secrets, connection strings, or
other credentials in this file or in Git. Never assume a pasted preview URL is current.

## 4. Standing owner rules

These are the owner's own decisions, stated across many sessions. They are not suggestions. **Each
line is the rule, not the evidence.** The account of every one — incidents, PR numbers, measurements,
his own words at length — is in **[docs/agents-owner-rules.md](docs/agents-owner-rules.md)**, verbatim.

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in both UI and chat.
- **Never truncate text with an ellipsis.** The old "never let text wrap" companion rule is **superseded** by the no-horizontal-scroll golden rule below — where they collide, wrapping wins.
- When asked for N recommendations, give only the ones grounded in a real confirmed need. **Never pad a list to hit a number.**
- End every reply with a single recommended next step.

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead** — do not start implementing while the list is still being given.
- **Ask when the answer changes the outcome; decide when it does not.** Scope, business rules and data-correctness questions are always worth asking; permission to do obvious low-risk work is not.
- **Ask business-fact questions as an XLSX with dropdowns, not in prose** (his rule). Whenever the doubt is "which of these does each of these belong to" — bricks to areas, people to seats, products to lines — build one row per item with a locked data-validation list, include the context that makes the call easy and a free-text Note column, send the file, and read the answers back. Applies **everywhere in the repo**. Never guess an item to avoid asking, and never hand back a list for him to answer in chat.
- Take ownership. Automate the work rather than returning a checklist he has to execute.
- **"continue verifying" means RESUME the paused Source of Sales audit — never restart it.** The 20 finder agents already ran; **he stopped the run specifically to save usage**. Read `sos-audit-2026-08-09/CHECKPOINT.md` first, then resume. Never `resumeFromRunId`. Never overwrite the inputs.

**How to build**

- **Before building any new UI, inspect the sibling pages in that module and match their exact design identity.** Never invent a one-off look.
- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.** `overflow-x-auto` over a `min-width` floor IS the bug, not the fix, so a board bound by this rule must NOT use `PortalDesktopTable`; render `<table className="w-full table-fixed">` with a `<colgroup>`. **Fit by MERGING columns, never by shrinking type; WRAPPING is the permitted answer** and the ellipsis ban is untouched. **Measure, never guess** — `scrollWidth > clientWidth` over `main` at desktop AND 375px. **That check is BLIND to a POPOVER and certifies the page while one hangs off the side** — a nav panel sat 97px off a 375px screen, clipped not scrollable, with `main` reading 375/375 throughout. **It is blind the same way to any `overflow-hidden` BAND holding `whitespace-nowrap`** — clipped content adds nothing to `scrollWidth`, so the Stars of the Fortnight header sat 36px past `main` while every reading stayed clean. Inside such a container measure the CHILDREN's rects, and discount anything `aria-hidden`/`alt=""`: a decorative bleed is MEANT to cross the edge. For anything absolutely positioned, measure the OPEN element's own rect; and place it with `clampPanelToViewport`, since BOTH edges are in play and narrowing cannot fix an anchor's position. A native `<select>` is the one control this cannot fix and may NOT be shrunk. `never-horizontal-scroll-always-mobile-and-desktop-friendly`
- Admin shell: **desktop shows full tables/dashboards, mobile never does** — mobile gets cards.
- **One production deployment per task.** Bundle all phases into one PR; do not deploy per step.
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.

**Product rules that must not be "fixed" back**

- No payslip on any overview/landing page for any role — not the amount, not even the month label.
- 🔒 **A PHARMACY IS NOT A CONTACT — a CRM contact count is `PM` + `AM` only.** Pharmacies are separate: they stay OUT of the denominator the 90–120 rule judges and get their own tile. Never put `rows.length` beside the word "contacts" — route every printed size through one splitting helper — and **never name a row bag `contacts` when it holds pharmacies**, because the next session reads the field name and reprints the bug. Row label **"Pharmacist"**, count **"Pharmacies"**. `a-pharmacy-is-not-a-contact`
- Marketing Manager is hidden from the portal Incentive tab; GPM still sees it.
- The Organogram / AU seat model is the source of truth for org-structure and vacancy data.
- All SoS sales, historical and future, attribute to **today's** geography — never as-was.
- 🔒 **A CRM account label is `[Name ]( Area / Line )`, and `E`/`F` are RETIRED line codes.** The area sits between the brackets, the line is the letter after the final `/` or `-`. **`E` became `A`; `F` became `P`** — live codes are `A`, `C`, `P`, so a trailing `/ E` or `/ F` is old naming and **never an open question**. **The CRM admin never deletes an account**: he deactivates, strips the name, keeps the area, then CLONES — so a leaver's identity is unrecoverable from the CRM. **Cloning is safe; RENAMING is what corrupts numbers.**
- **Delta (3) territory move — LIVE, dated 2026-09-01, applied as a migration 2026-08-29.** The five areas (`D11`, `D24`, `D25`, `OT2`, `OT9`) sit on a dated PAIR, so **nothing is owed on 1 September** — do not re-apply, re-date or "finish" it. Resolver gap CLOSED both directions; recruitment CLOSED and `recruitmentAreaRegionOverrides` is PERMANENT. Keep the pre-image `delta3_defer_backup_20260829.line_area_map_pre`. **The SALES geography is DELIBERATELY LEFT ALONE (owner, Option A) — do NOT repoint `code_region_code`**, which can silently hide a district manager's own sales.
- 🔒 **THE AUGUST / DELTA (3) GOLDEN RULE — the August closing NEVER contains Delta (3), whenever it is published.** Owner: "golden rule, no negotiation", twice in one breath. **Already enforced — do not rebuild it**, at four levels including `runClosingPeriodDatingTests`, in the required CI `validate` job. **Never resolve closing geography at the run date**, and never offer to publish August "now that the move is live" — the date is the mechanism.
- 🔒 **Delta (3) is ANTI-INFECTIVE ONLY.** On CNS and Pedia the five areas do not move at all, in BOTH months. A sweep that finds them "half-migrated" across lines is reading the **CORRECT** state.
- 🔒 **THE CLOSING GOLDEN RULE — a closing is never done or sent during the month it covers.** Publishable on the **first day of the following month, Africa/Cairo**. Preparing a running month is fine; **releasing** it is what is forbidden, because publishing notifies every sales and product manager and a sent mail cannot be recalled. Enforced by `src/lib/sales/closing-period-gate.ts` + `tests/closing-period-gate.test.ts` in the required `validate` check. **`unpublishClosing` is deliberately NOT gated** — it is the recovery path. Do not add an override flag.
- 🔒 **THE OLD MONTHLY CLOSING EXPORT IS FROZEN — every new closing feature ships BESIDE it.** Owner: *"The old monthly closing sheet don't mess it. Anything we will do will be aside it."* Route, workbook, sheet set, layout and the black **Export XLSX** button — no restyle, no refactor. It is the auditor's file. New capability goes in the **premium** export. The one shared thing is `runExport`, pinned by `tests/sos-ui-truth.test.ts`. `the-old-monthly-closing-export-is-never-touched`
- 🔒 **The premium closing workbook FILLS the `.xlsm` engine — it never rebuilds one.** The engine is two Excel Tables plus `PickList`, driving 3 pivots **by table name**, 2 slicers and 120 INDEX/MATCH formulas. **Never round-trip the workbook through ExcelJS** — loading and re-saving silently destroys the pivots, slicers, tables and VBA. Rewrite the data parts inside the zip. Ship the template **EMPTY**: a filler that skips a sheet hands someone another line's real numbers under the right heading. `premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it`
- **Every weekly report and export MUST set `excludeUnmapped`** — an unmapped SKU double-counts against the real product. **An export must MATCH the screen**: never drop a sheet or column silently because it cannot be filtered — label it instead. The Weekly **Summarized Report's layout and scope are LOCKED**.
- **The system FLAGS an expense; it NEVER auto-rejects one.** **Never auto-publish a deductions month** and never approve a batch on your own initiative — CRM-derived detections run ~80% accurate, so it is always recommend, he confirms, then publish. **A same-day check against the CRM reads zero** because visits are entered through and after the working day — never report that as a measured zero.
- **CRM visit types `-5` (Public Holiday) and `-6` (Casual Leave) are WORKING days, never absence.** `-4` is the only real leave type, and only **FWC** reaches salary.
- **The Ready-sheet >25th full-pay waiver is for genuine RESIGNATIONS only** — terminated and inactive leavers stay prorated with zero allowances. **A regional employee travelling TO Cairo earns no outstation per-diem** (live — do not undo). **DSM and Medical Rep titles auto-provision their real role**, and the title-governance guard was DELIBERATELY relaxed for those two.
- **Social-insurance Form 1 prints exactly as the Authority issues it** — page 2 carries nothing Phoenix wrote, and the whole form is duplex.
- **The organogram XLSX carries a Mobile column**, by his explicit override of the work-fields-only export rule. Fetched at export time: do not remove it.
- **The public Territory Management preview link must NEVER display or offer the line** — pinned to Pedia server-side. **The organogram CHART and the employee detail popup read two different sources**, so a per-person field on the chart means editing the seat report's select. **The one-press WhatsApp button STAYS on the CEO and NSM rows** — he was asked directly and said keep it.
- 🔴 **The CEO is NOT a district, and a picker is never wider than its viewer.** An org walk that climbs to `AA` presents the whole board's scope as the CEO's own doctor panel, and a cached company-wide filter tree offered a Medical Rep the names of all ~73 reps. **The damage is an EMPTY board**, which reads as "you covered nothing" rather than as a bug. Pass the viewer's scope to the PICKER as well as the query. `the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer`
- 🔴 **An NSM's outstation expense is NEVER held** — *"once submitted, once accepted."* **NSM only** — it does not extend to the three photo-waived roles. `nsm-outstation-expense-is-never-held`
- 🔴 **The mailbox-monitor app-password entry is `___`, never "Phoenix".** The monitor UI must never print the word Phoenix anywhere in that instruction. `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix`
- 🔒 **Turbify CANNOT issue app passwords centrally — the owner is STAYING, so do not re-pitch a migration.** There is no API and never was. Employee mailboxes are **unmonitorable at scale**, and it is SETTLED — costed at ~$420/month for 60 seats, answered *"NO LEAVE ME AS I AM NOW."* `turbify-cannot-issue-app-passwords-centrally-owner-stays`
- 🔴 **A password reset does NOT revoke a Turbify mailbox — the app passwords survive it.** It locks the WEB mailbox only; every phone and Outlook client keeps sending and receiving company mail, and the control panel shows nothing wrong. **Both steps are required** — reset AND delete the app passwords, or delete/suspend the mailbox. Never tell the owner (or write in a UI) that a reset closes a leaver's mail access. Tracked in `public.mailbox_offboarding_tasks`, where a row is an **attestation**, never an observation. `a-password-reset-does-not-revoke-a-turbify-mailbox`
- **Four sales-attribution facts that silently change a number.** EZ `1011654` splits EVENLY across Cairo+Giza CNS with the roster FROZEN per month; the closing reads the DISTRIBUTOR-PRODUCT rollup, so `fact_rollup` alone is INVISIBLE; a case-duplicate `line_area_map` row DOUBLED a whole line; and in the owner's sheets "Stores" means `Office` while "UPA" is a channel. `ez-is-credited-evenly-across-cairo-giza-cns-reps` · `closing-reads-distributor-product-rollup-not-fact-rollup` · `a-case-duplicate-line-map-row-doubled-a-whole-line` · `owner-sheet-vocabulary-stores-is-office-upa-is-a-channel`

### 4.1 Marketing customer, venue and licence validation

Full account: **[docs/agents-owner-rules.md](docs/agents-owner-rules.md) §4.1**.

- 🔒 **Venue validation is GPS + a live picture ALWAYS — and leg 3 (the registered code, else the licence) is a PHARMACY rule ONLY.** Owner rule, since amended. A venue outside the pharmacy trade is judged by no route at all — `resolveVenueIdentityRoute` answers **`admin`**, never `none`. **Do not over-apply it:** a codeless PHARMACY is still refused, and the code route stays closed to a nursery. The licence is a **fallback identity route**, never evidence in its own right. Direct-order desk only, **not** marketing. **`nursery` is the venue type for ANY venue with no distributor account, and that is the OWNER'S OWN FILING** — a clinic filed as a nursery is **correct, not a data-quality defect**.
- 🔴 **Marketing pharmacies are TERRITORIAL, and a NULL `area_id` makes one invisible.** **Owner rule: the REGISTERED CODE beats live GPS.**
- 🔴 **A licence verdict is PERMANENT and has no correction path.** Write-once at approval — not even a Super Admin can correct a wrong one, and it is then displayed indefinitely. **Ask the owner before the first one is recorded.**
- 🔴 **`system_validated` means NO HUMAN LOOKED.** The screen is **Super Admin only** — not SFE.
- 🔴 **A venue's evidence was WRITE-ONCE, writable only at insert** — now fixed. **AREA governs both sight and reuse; never backfill ownership.**
- 🔴 **The badge read a FROZEN note, never the live evidence.** EITHER half reaching `complete` clears it.
- 🔴 **A duplicate merge STRANDS the desk validation on the retired row.** Repair it with hand SQL, not code.
- 🔴 **The screen that SHOWS a badge is not the screen a rep can OPEN.** Check the gate before wiring any `actionUrl`.

## 5. Session, worktree, and parallel-work safety

Before editing, run `git status`, `git branch --show-current`, `git log -1 --oneline`,
`git worktree list`. **Each line is the rule, not the evidence.** Measurements, dates and incidents
are in [docs/agents-worktree-and-machine-limits.md](docs/agents-worktree-and-machine-limits.md).

- Use one working tree per active session. **Never two interactive sessions in one folder** — the SessionStart lock warning is a hard stop. (A crashed session's lock self-expires after 2 hours; a lock whose PID is not a running process is stale.)
- Start new work from the latest `origin/main` on a focused `codex/<task>` branch unless told otherwise.
- Never run `git clone`, `git init`, or anything that recreates the primary repository's `.git`.
- Never discard, overwrite, clean, reset, or revert changes you did not create. Treat unexpected changes as the owner's work. If the tree is dirty, classify and preserve it.
- **Never delete a `.xlsx` or `.pdf` file**, even a stray untracked one in a worktree being cleaned up. Scan any folder for them before removing it; if found and not identical to a git-tracked copy, move them into `xlsx/` at the repo root.
- **Start a session with `node scripts/new-session.mjs <task>` — one command for the whole four-step ritual** (fetch `origin/main`, create `_wt-<task>` on `codex/<task>`, junction `node_modules`, copy the gitignored env files). It refuses below 6 GB of free commit charge. `--status` prints live headroom, `--repair` fixes a worktree missing either piece, `--from <ref>` branches elsewhere. **`git worktree add` is only step one of four** — it never copies gitignored files, so a hand-made worktree has no `.env.local` (dev-auth and the dev server then fail silently) and no `node_modules`.
- **Never `pnpm install` inside a worktree, and never `pnpm run` there.** `pnpm run` purges `node_modules` once it sees the lockfile has moved, destroying the junction before your script starts. Invoke `node scripts/…` directly. The junction is enough for `typecheck`, `lint` and `node scripts/…`, but **not for `next dev`** without the explicit `--webpack` flag (§2.1, Worktrees).
- Prefer worktrees as siblings (`git worktree add ../_wt-<task>`). If one must live inside the repo, its folder name must start with `_wt-` (or sit under `.codex-worktrees/` or `.claude/worktrees/`) — those patterns are excluded from `tsconfig.json`, `eslint.config.mjs` and `.gitignore`; a folder matching none silently makes every local `typecheck`/`lint` several times slower. Locked worktrees under `.claude/worktrees/` belong to other live sessions — never remove them.
- **Remove worktrees with `node scripts/new-session.mjs --remove <task>`**, only after approval. It runs three gates in cost order — untracked `.xlsx`/`.pdf` rescue scan, uncommitted work, then commits on no remote branch **and** with no merged PR — drops the junction with `cmd /c rmdir`, and re-reads the folder's branch live rather than trusting an earlier scan. That last gate asks the merged PR, never reachability — **a squash-merged branch legitimately holds commits `main` does not.**
- **`git worktree remove` leaves a HUSK, and nothing built into git can see it.** It leaves the gitignored payload — `node_modules/`, `.next/` — with no `.git` file and no registry entry, so `git worktree prune` cannot find it. **Run `pnpm run repo:doctor`** after any removal: it reports by default, and `--fix` deletes only husks proven to hold zero files.
- **A memory file with no index line is invisible, not merely hard to find.** `pnpm run repo:doctor` reports them (and pointers whose file is gone) in a MEMORY INDEX section; `--deep` lists every one. It is read-only.
- **Worktree payload — not git, not tsc — is what makes this checkout feel slow.** Roughly 99% of the path count is worktrees, and tools honouring `.gitignore` never see it, so validation looks healthy while the session crawls. **Do not tune `tsconfig`/`eslint` — those excludes are already correct.** Retire merged worktrees and clear husks. Cost is path COUNT, not gigabytes.

**Machine limits.** RAM is soldered at 16 GB. One dev server at a time, ever; one typecheck/build at a
time locally — parallel validation belongs to CI.

**The binding limit is the Windows COMMIT charge, not RAM, and it is not a constant** — it is RAM plus
the pagefile *as currently allocated*, so it FLOATS. **Never budget headroom against a limit you did
not just read:** `Win32_OperatingSystem.TotalVirtualMemorySize` is the limit and `FreeVirtualMemory`
the headroom, both KB, and `node scripts/new-session.mjs --status` prints both live. **Sessions were
never the ceiling** — idle ~0.5 GB vs ~3.5 GB for a dev server, build or cold typecheck, so the real
limit is about 5 concurrent HEAVY jobs. Watch the headroom, not a session count.

Route work by tier:

| Tier | Where | Use for |
| --- | --- | --- |
| **A — Cloud session** *(the default)* | Isolated cloud clone, ends in a PR | Any independent task not needing localhost browser verification, local files, or local credentials. Sonnet by default. |
| **B — Local worktree** (max 2–3 woken) | Sibling `_wt-<task>` | Only tasks needing browser preview, dev-auth role sweeps, or local creds. |
| **C — Main checkout** (exactly one — the control tower) | primary repo folder | Reviews, merge/deploy decisions, DB operations, deployed-env verification, worktree triage. Never feature edits. |

Only the control-tower session rewrites the memory index; others may append memory files but never
reorganize it. Cloud sessions cannot see local state — put everything they need in the task prompt.

## 6. Approval rules

Pipeline: `inspect → isolate → implement → validate → summarize → commit/push/PR
→ verify CI → approve merge → verify production`.

**The default decision is: PROCEED.**

Complete every pre-approved step automatically and ask for permission ONLY at one of the two
protected actions below. Do NOT repeatedly ask for confirmation ("Should I proceed?") for
pre-approved actions. If a task requires no protected action, complete it without asking.

**PRE-APPROVED ACTIONS (proceed automatically):**
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

**PROTECTED ACTIONS (stop and require separate, explicit approval before):**
1. Merging any branch or Pull Request into `main` or any production branch.
2. Running or applying any database migration against the production database/environment.

**Git hygiene.** Review `git status`, `git diff`, `git diff --cached` before committing. Stage only
files owned by the task. Never commit `.env*`, `.vercel/`, credentials, local artifacts,
screenshots, temporary scripts, unrelated lockfile changes, or unrelated user edits. Use
conventional messages (`fix(module): reason`, `feat(module): capability`, `docs(agents): change`).
`main` is production — never edit it directly. `delete_branch_on_merge` is on, so GitHub deletes the
**remote** branch automatically; the local branch and worktree survive and still need approval to
remove.

## 7. Validation

**CI is the gate. Do not run a local full validation.**

`check:harden` was retired on 2026-08-18 at the owner's instruction, along with the
`ask-before-validation` hook. Do not reintroduce any of them, and do not invent a replacement — no
"quick subset" of lint + typecheck before pushing, no `pnpm run ci` as a pre-push ritual. **Push the
branch and let the PR's checks answer.**

This is safe because the local gate never gated anything. `.github/workflows/ci.yml` re-lists every
step itself, and the four **required** checks — `validate`, `lint`, `typecheck`, `secret-scan` — run
on the PR head commit and block the merge if any is red.

`pnpm run ci` still exists for the rare case where you genuinely need the answer before pushing. It
is opt-in: run it **only when the owner names it**.

Two things are NOT covered by a PR's CI and still need a check immediately before the action:
**migrations** and **production deploys**.

Verifying a UI change in the browser is not validation at all — reload and look.

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
workflow to watch. Confirm a deploy through the GitHub deployments API
(`gh api repos/Gawish-1997/phoenix-people-workforce/deployments`) or `railway status`, and confirm
what actually serves traffic by requesting `/api/healthz` and reading `revision`. Use the live
staging app (§3) to smoke-test before a risky production deploy when there is time. After a
runtime-impacting production deploy, verify the public domain, smoke-test the changed workflow, and
inspect production logs (`railway logs`). When a page fails, capture the visible error, browser
console, network/API response, deployment logs, and database/RLS evidence before proposing a fix.

## 8. Supabase and data safety

- **Supabase writes are pre-authorized end to end — NO approval prompt** (owner's `autoMode` grant, applied by hand 2026-08-02, which deliberately removes the §6 gate for Supabase). It covers the `supabase-staging` and `supabase-production` MCP servers, the owner's connector `mcp__45bb6356-…`, and the `supabase` CLI (incl. `db push`), on staging AND production — every read tool and every write tool: `execute_sql` mutations, `apply_migration`, bulk and destructive SQL. **You do NOT wait for a separate approval.** The one standing condition: **announce any destructive or bulk PRODUCTION change in plain words before you run it, and give the owner a chance to stop it** — the removed prompt is a UI gate, not licence to skip telling him. (This grant does NOT cover creating/deleting a project or reading secrets.)
- All schema changes must be migration-based, repeatable, reviewable, and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref, resolving it with `list_projects` rather than trusting a ref pasted in a prompt or copied from an older doc.
- Both named servers can see **every project the account is entitled to — all four in the §3 table.** **The server name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.**
- Any UUID-named Supabase tool (a claude.ai account connector) has an identity you cannot verify from its name alone, so it stays deny-listed by default. `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087__*` remains denied.
- **OWNER DECISION 2026-08-23: `mcp__45bb6356-…` stays DENIED.** It is the owner's own connector and was briefly allowed, but he was asked directly and answered plainly, so this is settled. Do not re-allow it, do not propose re-allowing it, and do not read a blocked call as a bug to chase — a `deny` is a silent hard block, not a prompt. Nothing is lost: the two named servers cover routine work, and this connector's grant was always the broader one (read+write on Secrets, Environment and Projects).
- Before destructive or bulk live-data work, inventory the target, create or verify a backup, show the exact mutation, and define post-change counts or checks.
- Verify RLS, grants, RPC authorization, service-role boundaries, and browser-role exposure whenever permissions or data access change. Service-role credentials stay server-only.
- Visibility in this app is **application-scoped, not RLS-scoped** — most code paths use the service-role client. Changing auth or sessions will not move what a user can see, but a `?? getSupabaseAdmin()` fallback is a silent fail-open.

## 9. Stop conditions

Stop before delivery or mutation and explain the blocker when:

- The target branch, worktree, environment, project, or requested scope is uncertain.
- Unrelated changes cannot be isolated safely.
- Validation fails and the proposed action would publish known-broken work.
- A PR is conflicted, required checks are failing, or the preview is not the expected deployment.
- A secret may have been exposed. Do not repeat it; recommend revocation and replacement.
- A destructive action lacks a verified target, backup, recovery path, or explicit approval.
