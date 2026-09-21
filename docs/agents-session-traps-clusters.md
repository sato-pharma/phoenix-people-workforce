# Session-level traps — the clusters

**This file is the body of `AGENTS.md` §2.1, moved out of the auto-loaded context on 2026-09-12.**
It is not loaded on every request. `.claude/hooks/trap-injector.mjs` (PreToolUse) matches what a
session is about to run and injects the matching cluster ONCE per session, so the git traps arrive
when you touch git and the ExcelJS traps when you build a workbook — instead of all 30 KB of them
arriving on every turn.

**Each line is a cue, not the fact.** The account of every one — measurements, dates, PR numbers,
the diagnosis traps — is in **[docs/agents-session-traps.md](agents-session-traps.md)**; search it
for the hook's wording. Which memory backs which hook:
[docs/agents-memory-map.md](agents-memory-map.md).

**The heading format is load-bearing.** The injector parses a cluster as a bold run alone on a line
(`**Git**`, `**Worktrees** (see also §5)`) and takes everything up to the next such line. Do not
change a cluster name without changing `RULES` in the hook, and do not introduce a bold-only line
inside a cluster — it starts a new one silently.

**Read this file in full when the injector is not loaded** — a session started before the hook
merged, or any environment with no `.claude/hooks/`. The hook fails open and says nothing when it
does not fire, so its silence is not evidence that no trap applies.

**Shell and tooling**

- **`grep -r` hangs on this checkout — use `git grep` or `rg`.**
- **MSYS mangles paths silently, four ways:** `git show <ref>:<path>` returns EMPTY; `grep -c $'\r'` matches EVERY line of a pure-LF file; a `git grep`/`rg` PATTERN holding a leading-slash path matches NOTHING — 41 hits read as 0, i.e. *the code is clean*; and **a NATIVE Windows binary cannot resolve `/tmp` at all** (it is `C:/Users/<you>/AppData/Local/Temp`) — bash writes the file and `wc`/`grep` read it, while `rg` says *cannot find the path* and `curl -o` exits 23. Export `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` first; save with `>` rather than `-o`; never quote a count without it.
- **`git grep -E` is POSIX ERE, where a backslash inside `[...]` is a LITERAL BACKSLASH — so a character class written for `rg` silently matches NOTHING.** Same pattern, same file, measured: `-E` **0**, `-P` **9**, `rg` **9**. The 0 reads as *the code is clean*, and the pattern looks right because it IS right everywhere else. Use `-P`, or keep the class free of `\[`/`\]`.
- **`TZ=Africa/Cairo date` silently returns UTC in MSYS — 3h early, no error**, so recent work reads as old. The tell is a Cairo reading at `+0000`; the clock is ALREADY `+0300`, so use plain `date` or node, never `TZ=`. `tz-africa-cairo-silently-returns-utc-in-msys`
- **A role probe cannot trust the HTTP status code**, and **a POST to ANY `/api/**` path returns 403 even when the route does not exist** — probe with GET.
- **`curl -d "@-"` creates NOTHING on Windows** — write the JSON to a file, pass `-d @file.json`.
- **`pg_dump` piped through stdout on Windows writes CRLF into every `COPY` row — exit 0, plausible size, empty stderr, and the restore puts a stray `\r` in the last column of every row.** Use `pg_dump -f <file>`, which writes clean LF, and verify the archive's row counts against the live tables *before* the drop.
- **Reads of `.env*` are auto-approved deliberately, for EVERY key** — licence to inspect, never to propagate. Do not re-litigate or narrow it.
- **A permission allow-rule stores the LITERAL command, so an inline env var bakes a live credential into `settings.local.json` in plaintext.** Grep `settings.*.json` for `TOKEN=`/`KEY=`/`SECRET=` before sharing or merging.
- **`mcp__supabase-staging__*` is PINNED to staging** (`project_ref` in `.mcp.json`) — no `project_id`, no path to production.
- **The Supabase MCP returns ONLY the last result set of a multi-statement `execute_sql`** — earlier ones vanish with no error, so a block that verifies in statement one and summarizes in two certifies a check you never saw. One question per call.
- **A Windows USER env var SHADOWS every `.env.local`, silently.** Re-probe all three; never print the value.
- **ONE Supabase token wears TWO names — `.mcp.json` expands both from the SAME Windows user env var, so deleting either name kills MCP.** They are not a spare and a primary; treat a "duplicate" token entry as load-bearing. `supabase-access-and-prod-token-are-one-token`
- **`CLAUDE_PROJECT_DIR` is the SESSION'S OWN worktree, never the primary** — measured in all three layouts, and the published docs say otherwise, so a hook that trusts them writes to the wrong tree and breaks SILENTLY. `claude-project-dir-is-the-sessions-own-worktree`
- **The local attendance agent dies at EVERY logon and loses NOTHING — do not escalate it.** Never disable the 2-hourly task, never launch a second agent (it can fire a PRODUCTION sync).
- **ExcelJS emits two schema-invalid OOXML fragments, so Excel silently REPAIRS the workbook** — both need the `.xlsx` zip post-processed. **Never HUNT it — Excel NAMES the part in `%TEMP%\error<digits>_01.xml`.**
- **LOOKING at a generated workbook has THREE modes that LIE, and the third lies the OPPOSITE way — a BROKEN file reads as CORRECT.** `--convert-to png` renders only the LEFTMOST columns and an ExcelJS load-and-save "review copy" DROPS the merges — both make a correct file look broken. But `--convert-to html` REBUILDS a pivot from its declared source every load, IGNORING `refreshOnLoad`, so a STALE cache renders FRESH. Use html for cell values and the pivot's SOURCE; `refreshOnLoad` is provable only STRUCTURALLY. `looking-at-a-generated-workbook-two-ways-that-lie`
- **A `Win32_Process` filter on `CommandLine` MATCHES THE PROCESS RUNNING IT** — the sweep kills its own shell, so the command dies at `exit 255` with NO output, which reads as a permissions or path fault. Exclude `$PID`.
- **A scheduled task's STATE cannot tell you a long-running job is alive** — it reads `Ready` with a SUCCESSFUL last run over a process dead for minutes; `0xC000013A` in `LastTaskResult` is a Ctrl+C-class kill, not a clean finish. Only a heartbeat file plus a live process check answers, and **a task that dies is NOT restarted by restart-on-failure** — give it a repeating trigger and make the script a no-op when a healthy instance exists. **`@($null).Count` is `1`**, so a count taken from a call that FAILED reads as one real row.
- **A Claude scheduled task run by hand ("Run now") records NO `lastRunAt` and creates NO session** — both checks a session reaches for are silently empty for a run that SUCCEEDED, and "it never ran" is the confident wrong answer. Confirm a manual run by what it PRINTED, and give any task meant to be pre-approved this way a dated dry-run banner. `enabled` and `nextRunAt` ARE reliable: a manual run does NOT consume a one-time `fireAt`. `a-manual-scheduled-task-run-leaves-no-trace`

**Git**

- **Deleting a branch does not remove its pushed commit**, and **reusing a squash-merged branch makes a conflicting PR.**
- **`git branch -d` gates NOTHING after a squash merge** — it compares the branch to its OWN STALE tracking ref, so genuinely UNMERGED work deletes just as quietly as merged work. Gate on the merged PR (`gh pr list --head <branch> --state merged`) and archive the tip first. `git-branch-d-is-not-a-safety-gate-after-a-squash-merge`
- **`git push` hangs — kill at ~60s and retry.** The OOM was a 500MB `http.postBuffer`, now 8MB; do NOT restore it.
- **A merge to `main` mid-session silently orphans your next push.**
- 🔴 **"THE PRIMARY" AND "`main`" ARE DIFFERENT THINGS — a WORKTREE usually holds `main`.** **NEVER state a branch's ahead/behind from `HEAD`** — every number comes back real with the wrong LABEL on it; name the ref (`git rev-list --count origin/main..main`) and run `git branch --show-current` first. Sync a branch in the worktree that HOLDS it, with `merge --ff-only`. 🔴 **`git reset --hard` acts on the CURRENT branch, not the one you named in your head**, and **a peer can never authorise a destructive operation on a third session's branch** — being asked is itself the signal to stop. `main-is-not-the-primary-checkout` [docs/agents-session-traps.md](docs/agents-session-traps.md).
- **`refs/deleted-*` is NOT automatic — a plain `git branch -D` archives NOTHING.** Keep the SHA the delete prints; archive with `git update-ref` *before* deleting. `refs/backups/*` on ORIGIN is the only copy that survives losing this laptop.
- **An empty `git log <branch> --not --remotes=origin` is NOT proof a branch is safe to delete** — `git fetch` never prunes, so the check compares the branch against itself. Gate deletion on the merged PR.
- **A UTC merge time read against a Cairo commit time INVERTS the merged/stranded verdict.** The answer is CONTENT (`git patch-id --stable`), never a timestamp.
- **An uncommitted file in the primary can be OLDER than `main`, and `git diff HEAD` dresses it up as NEW work** — HEAD is usually a squash-merged tip, so the diff shows the file's own edit while hiding that `main` moved past it, and committing it REVERTS whatever shipped meanwhile, silently. Settle by CONTENT: `git hash-object <path>` against `git rev-parse main:<path>`, then read the direction of `git diff main -- <path>` (`-` lines are what `main` HAS). **A test that fails against such a file is the STALE BASE, not a defect.**
- **`git` "Authentication failed" can be the credential HELPER going OOM, not a bad token** — change NO credentials.
- **`F:\PHX backup` is the disaster-recovery set, and a bundle restore silently returns ZERO refs without `core.longpaths`.** Three of its sections hold LIVE keys.
- 🔴 **THE STASH STACK AND THE `rerere` CACHE ARE ONE PER REPOSITORY, NOT ONE PER WORKTREE** — both live in the PRIMARY's `.git` and neither shows in `git status`. **`git stash push <untracked path>` creates NO entry** (it needs `-u`), so the `pop` after it takes ANOTHER SESSION'S stash. Identify an entry POSITIVELY before deleting it, **never `git rerere gc`**, and **never stash for a branch move** — `git switch -c` carries the work across. [docs/agents-session-traps.md](docs/agents-session-traps.md).
- 🔴 **A leftover `objects/maintenance.lock` stops git's own maintenance SILENTLY — and removing it can let `git rerere gc` loose.** While the lock exists, EVERY `git maintenance run`, automatic or typed by hand, does nothing and exits 0; git 2.55's DEFAULT automatic run executes `git rerere gc` over the shared cache. **Pin `gc`, `geometric-repack`, `rerere-gc`, `reflog-expire` and `worktree-prune` off BEFORE removing a lock** (`git config maintenance.<task>.enabled false`), and always NAME the task: `git maintenance run --task=loose-objects`, twice. repo-doctor's GIT MAINTENANCE section reads the lock, the pins and the backlog. [docs/agents-session-traps.md](docs/agents-session-traps.md).

**CI and PRs**

- **CI jobs failing in SECONDS mean billing, not code.**
- **`secret-scan` is a required check — there are 6 (`test` and `mobile` joined 2026-09-18) — and it is the one that never runs on a `main` push.** Its absence from a merge commit is CORRECT.
- **`gh pr checks` LAGS behind the real job state.**
- **`check-runs: 0` also means CONFLICTED** — a conflicted PR runs no CI at all, which reads as "not started".
- **ONE new hub page trips FOUR separate CI gates.**
- **A red `main` still builds, ships and serves perfectly**, and a green PR is not a green `main` — after merging, check the run on `main`'s NEW head.
- **A docs-only PR's `validate` runs NO tests — it skips the expensive steps, ~10s.** The fast path is `pull_request`-ONLY, so the suite's FIRST run is the push to `main` — production's branch. Three PRs shipped `main` red this way; a `validate` under ~30s is the tell.
- **Runs NEVER CREATED is an Actions OUTAGE, not billing** — billing creates the run and fails it in seconds. Check githubstatus BEFORE touching the spending limit. A `workflow_dispatch` run never enters a PR's `statusCheckRollup`.
- **Recover a PR with `gh run rerun <id>` on its OWN `pull_request`-sourced run** — it keeps the `event`, so its checks DO reach the rollup. Then WAIT: dispatch lags 20–30 MINUTES during an outage and events are NOT dropped. Fire ONE recovery event and leave it.
- **An extra SHA does not merely waste a run — it ACTIVELY KILLS the real head's**, because `ci.yml`'s concurrency group is the same for every commit on a PR. Never push an empty commit to force a `synchronize`.
- **`actions/runs?head_sha=` needs the FULL 40-char SHA** — an abbreviated one returns `total=0` with no error.
- **`gh run list` is EVENTUALLY CONSISTENT — it dropped a run that existed**, in the minute another commit merged: a commit whose CI had already passed read as *main has no verdict*, from inside a 20-row window that should have held it. Ask by commit, not by scanning the list — `gh api "repos/Gawish-1997/phoenix-people-workforce/actions/runs?head_sha=<full sha>"` answered correctly at the same moment (measured 2026-09-17, while building the `ship` skill).
- **A push to `main` during an outage ships to PRODUCTION with no CI run at all.** Recover with `gh workflow run ci.yml --ref main`.
- **The GitHub repo is `phoenix-people-workforce`; the FOLDER, npm package, `supabase/config.toml` and dead GCP project are all `phoenix-workforce`.** A path built from the checkout name 404s, which reads as *the deploy never happened*. `gh repo view --json nameWithOwner` settles it.

**Migrations**

- **A migration FILE written is not a migration APPLIED**, and **a merged migration file does not mean the grants are live.**
- **Migration timestamps COLLIDE across parallel branches, and CI judges the MERGE ref — so a green `check:migrations` flips RED with NO change from you, over a file that is not on your branch at all.** Reproduce by extracting main’s copy in; a green local suite cannot see it, and the second red on a PR is NOT the first one again. And **the ledger version never matches the filename — ask the ledger by NAME, and READ the row: one embeds its old filename in `name`.** A prefix lookup reported 11 of the 12 newest files *not applied* when 10 of those 11 were. **Applied-state also FLIPS mid-PR**, so re-read it before asserting one durably.
- **A PostgREST `.in()` fails 3 ways: ZERO rows and NO error; `22P02` on ONE null id; headers over ~16KB.** Chunk at ~50, drop nulls.
- **A `neq` against an ABSENT jsonb key matches ZERO rows**, and **an unbounded `.select()` stops at 1000** with no marker. Write the OR-form; `count(*)` before trusting any select, then page with an explicit `.order()`.
- **`n_live_tup` is STALE in production — it reports LIVE tables as empty.** Sweep with a real `count(*)` via `query_to_xml`.
- **A Supabase client request that times out at 15s STILL COMMITS**, leaving a half-applied state with no audit row. Do heavy multi-step mutations in ONE `plpgsql` function.
- **A missing TABLE answers `PGRST205`, NOT `42P01`** — so the obvious guard fires never and the deploy-before-migration window 500s a whole page. Treat both codes as one set behind one helper. `a-missing-table-answers-pgrst205-not-42p01`

**Database, grants and RLS**

- **A write REVOKE does NOT make a table read-only** — `ON DELETE CASCADE` and `SECURITY DEFINER` both run as the table OWNER, and `has_table_privilege` sees neither bypass. Fixed on prod; **do not redo or undo.**
- **An append-only table needs a STATEMENT-level `BEFORE TRUNCATE` trigger** — `TRUNCATE` fires no ROW triggers, and a revoke never binds the OWNER. Prove all three verbs are refused.
- 🔴 **A dependency sweep over views, functions, triggers and FKs MISSES RLS POLICIES, and `DROP … CASCADE` then deletes them SILENTLY** — and cascade is what Postgres's own HINT tells you to use. A policy's expression is a surface of its own (`pg_policy.polqual`/`polwithcheck`), so a clean sweep reads as *nothing depends on this*. Ask `pg_depend`, which sees every surface at once, and **carry a POSITIVE CONTROL**: without that contrast an empty result is indistinguishable from a broken query. [docs/agents-session-traps.md](docs/agents-session-traps.md).
- **RLS on with no `authenticated` grant is the NORM here — ~4 in 5 public tables (258 of 326, 2026-09-04) — not a defect class to sweep.**
- **ONE `auth.users` row with `banned_until = 'infinity'` 500s the ENTIRE GoTrue admin API** — page-shaped, so a small `per_page` probe passes. Retire with the app's finite `876000h`.
- **`au.f_monthly_achievement` SERVES A PRECOMPUTED ROLLUP, and its fingerprint covers the CONFIG surface — NOT the sales data.** So repairing an import or rollup row changes NOTHING on Sales vs Target or its five siblings — no error, no staleness marker, the old number just keeps coming. Run `au.f_refresh_monthly_attribution(period)` after ANY sales-row repair, diffing stored against live first so the refresh is a check, not a hope. `attribution-rollup-fingerprint-ignores-the-sales-data`
- **The ATS data model carries four traps that each read as normal.** The offer chain was live in the registry with a HOLE past `approved_at`; the `ats_candidate_*` children have NO FK and one is a VIEW; a CV RE-READ never wrote what it read (`applied_fields` is NOT the writer); and `medical_rep` reads 12 fields where `universal` reads 38. **NEVER raw-SQL `national_id`/`email`/`phone`** — the `_norm` dedupe index is app-maintained. `offer-chain-was-live-in-the-registry-with-a-hole-past-approval` · `ats-candidate-children-one-has-no-fk-and-one-is-a-view` · `cv-extraction-reads-governorate-but-never-applies-it` · `the-medical-rep-cv-schema-reads-12-fields-universal-reads-38`
- **A CV import OVERWROTE a candidate's whole identity — detect it with a per-candidate SENDER COUNT, where healthy is 1.** The allowlist holds an INBOX, not a sender, so never resolve a CV by sender; and the CV file lives in `ats_files`, NOT `cv_external_url`, which is empty for EVERY candidate and reads `NO FILE`. `a-cv-import-overwrote-a-candidates-whole-identity` · `the-email-import-allowlist-holds-an-inbox-not-a-sender` · `cv-file-is-in-ats-files-not-cv-external-url`
- **An empty paid stamp on an outstation trip is NOT an unpaid trip for July or August 2026.** `outstation_expenses.imported_payroll_batch_id` / `imported_to_payroll_at` are written by PUBLISH only since 2026-09-12 (#3786), and those two months were deliberately never backfilled — all 347 approved trips read empty. Prove a payment from that month's `salary_records.expenses`. **A stamp is not proof of a FULL payment either:** publish marks every approved trip even when the typed figure is lower, and records the gap only in `detail.expenseStamp.differing` on the run's `published` row in `automated_payroll_audit`. [docs/agents-session-traps.md](docs/agents-session-traps.md).

**Probing, attributing and reporting production**

- **A 200 from a health endpoint can be blind to the thing that is broken** — OpenAI's `/v1/models` certifies a key with no balance. The BILL cannot be read from the API at all.
- **`app_error_events` returning 0 rows means QUIET, not broken.** Prove the route with 405 against a 404 control; never POST a synthetic error to production.
- **A client-error census by MESSAGE reads iOS-ONLY on an every-platform failure** — masking blanks the Android and desktop messages and spares iOS WebKit's, so every legible row is an iPhone: 112 Android vs 39 iOS, ONE cause. Group on the STACK; never platform-predicate the FIX. `census-client-errors-by-stack-not-message`
- **The Error Monitor HIDES rows whose `environment` is NULL**, and a `create table … as select` copies rows but never RLS — **measure the new table's ACL, never assume it either way.**
- **`updated_by_hr_id` LIES about who wrote a row.**
- **HR ids are MIXED CASE, so a plain `.eq` silently under-returns** — one `.eq` hid 28% of reps' own orders, and on `au.occupancy_history` the loss is TOTAL (0 of 120 join), where a row matching nobody reads as *a vacant seat* rather than a bug. Lower BOTH sides.
- **The Sato logo's wordmark is WHITE, so "SATO" vanishes on white paper.**
- **`railway logs --http` without `--since` returns only a SHORT recent window (about 12 minutes, as measured), whatever `--lines` says** — so a filtered count can read as *zero calls* while traffic flows: 3 WhatsApp webhook calls without it, 126 with it. Always pass `--since` (an ISO timestamp, or ONE unit like `2h` — `2h30m` is refused); HTTP logs exist only for the CURRENT deployment, and a REMOVED one returns nothing.
- **Judge a WhatsApp SILENCE by DELIVERY LAG, never by quiet alone** — Meta re-sends a failed webhook for up to 7 days, so a real outage leaves inbound rows whose `received_at` sits far behind `sent_at`. Leave out backfilled rows (`payload ? 'backfill'`) and history replays (`historical`); zero late rows plus a seconds-scale lag means NO TRAFFIC, not an outage. It cannot see a 200 that recorded nothing — pair it with `app_error_events` and each line's first and last message.

**Validation**

- **A repo-wide pattern sweep must grep the TESTS for the old string too — a pinning test can pin the ANTI-pattern.** `runTest` rethrows, so a loop over N routes reports only the FIRST. Run `git grep -l '<the exact old line>' -- tests` first.
- **A test name appended beside an existing one in `tests/run-tests.ts` becomes an ARGUMENT, not a registration — and a MERGE CONFLICT is the commonest route to it.** Every new-test PR appends at the SAME anchor, so git puts the conflict INSIDE one `await runTest(` call: keeping both sides yields ONE call taking four arguments, which compiles, goes green, and silently retires the OTHER PR’s test. One `await runTest(name, fn)` per test; check by AST.
- **`node --test <file>` on this repo's suites passes VACUOUSLY** — each is an exported function registered in `tests/run-tests.ts`, so a file with no `test()` call reports `pass 1` for merely IMPORTING. It reported pass on a check deliberately broken. Call the exported function, and prove RED before quoting a local green.
- **RAM-saturated? WAIT — do not skip validation for it.**
- **Source-pinning tests slice a fixed BYTE window and false-FAIL** when the file shifts.
- **A heredoc eats backslashes** and yields a test that only ever passes.
- **`parseDiagnostics` is SYNTAX-ONLY — it cannot see a typecheck error.**
- **A local typecheck printing ZERO errors can mean it never TYPE-checked at all.** A truncated `.next/dev/types/routes.d.ts`, what an interrupted dev server leaves, stops `tsc` after the SYNTAX pass, so filtering `^\.next/` out reads as a clean 0 while CI goes red. The tell is `TS1005`/`TS1160`/`TS1161` under `.next/`. **Delete `.next` and re-run — never filter it away**, and treat a syntax error ANYWHERE as "the semantic pass did not happen". 🔴 **A BACKGROUNDED one fails the same way for a second reason: `node` is NOT on the background shell's PATH here, so `node …/tsc` exits 127 while the pipeline's LAST stage reports 0 — a run that never happened reads as clean, and was quoted to the owner as proof.** Run it in the FOREGROUND and print `node --version` beside the exit code. `typecheck-incremental-false-green`
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
- **A UI `timeZone: "UTC"` has THREE causes and only ONE is a bug — a blanket Cairo fix breaks all 43 remaining sites.** DATE-ONLY (a `date` column, a period key, a window bound) parses as UTC midnight, so UTC is what STOPS the calendar day shifting; a VENDOR wall-clock (`crm_save_date`, `check_date`) is ALREADY Cairo, so Cairo renders it 2–3h LATE; only an instant WE stamped belongs in Cairo. **Classify by the BACKING COLUMN, never by the formatter name** — `cairoMinutesOfDay()` reads UTC on purpose. `ireports360-timestamps-cairo-local-mislabeled-utc`
- **VERIFY THE EMITTED ARTIFACT, NEVER THE SOURCE — three defects shipped in ONE night from this, all green.** An escaped slash in a template literal, a font stack fixed in the body but not the footer's own copy, and a QUOTED font stack that closed a `style=""` and deleted the footer — each "verified" by reading the SOURCE. **Export the generated constant and assert on THAT**; compile an injected script with `new Function`; render the PDF and read the page count back. `verify-the-emitted-artifact-never-the-source`
- **`@/lib/utils` resolves to the ROOT `lib/utils.ts`, NOT `src/lib/utils.ts`** — editing the `src/` copy changes nothing, with no error. `at-slash-lib-shadows-src-lib-via-tsconfig-paths`
- 🔴 **A killed workflow run is RECOVERABLE — never write one off.** The missing agent LABEL reads as "a partial verdict cannot be mapped back to its finding"; that conclusion was written twice and threw away two runs' work. The journal carries `agentId`, and **`journal.result → agentId → transcript → first prompt → the finding`** closes it. Gate it on controls including a NEGATIVE one, and **never let an agent that DIED score a finding REFUTED**. [docs/agents-session-traps.md](docs/agents-session-traps.md).

**Memory and this index**

- **Sweep memories by CLAIM, never by filename or topic**, and never rewrite a dated record.
- 🔴 **`memory-index-reachability.mjs` run from a WORKTREE audits the PRIMARY's `AGENTS.md`** — it takes its root from `--git-common-dir`, so a slug you just added there is invisible and one you just deleted still reads `ok`. Its `0 stranded` is about the primary, not your branch. Run it from the primary, or grep the file you actually edited. `memory-reachability-classifier-reads-the-primarys-agents-md`

**Parallel sessions**

- **A parallel session can collide with NO git trace at all** — `gh pr list`, `git log` and `git worktree list` were all clean while another session edited the same file. Read the SessionStart working-tree line as a collision signal. A lock's dead PID proves NOTHING — it is the hook's own parent shell, so every lock has one; staleness is AGE — over 2h since its last refresh (a live session refreshes on every Bash, PowerShell, Edit or Write call) — and even a stale one does not prove the folder is unattended. Resolve by MERGING, never discarding.
- **ONE approval can reach SEVERAL sessions — N sessions holding the same "yes" is N executions.** Before executing a protected action on a terse approval, check how many sessions are live, say so, and re-verify the target immediately before acting. `mergedBy` naming the owner is NOT evidence of a human click.

**Worktrees** (see also §5)

- **Another SESSION can remove a worktree under you.**
- **A gitignored `_wt-*/` scratch folder makes a worktree look clean.**
- **The pre-push gate is GONE — a bare worktree pushes fine.** What it cannot do is RUN a suite.
- **`--fix` needs exactly ONE live session; `--strip-idle` does NOT** — it gates per worktree on dirty/unpushed/120-min-idle behind a lock, so RUN it with sessions open. **`--fix` can still FAIL on a locked husk** — then use `rmdir /s /q` from PowerShell, not Bash.
- **`--force` is the flag BOTH guards name in their OWN failure text, and it turns the concurrency check OFF.** The `--fix` census refuses at >1 session and this machine runs ~11, so **refusing is the NORMAL state and `--force` becomes the habitual answer**, which is how the guard erodes. The risk is never a wrong deletion (the zero-file proof is ungated) — it is two sessions cleaning at once, the one pattern that has lost work here. Close the others instead. The census **fails CLOSED**, so the same message appears when nothing is wrong.
- **`--repair` SKIPS every `.claude/worktrees/` path, and `ready()` counts a REAL `node_modules` as fine** — so a stray `pnpm install` there is invisible to BOTH tools, and `--remove` refuses the path too. The only tell is repo-doctor's file count against its siblings. Fix BY HAND: `rmdir` the real directory, then `mklink /J` to the primary's.
- **repo-doctor's RETIRABLE verdict names the branch a folder HAD at scan time.** Treat any scan older than the current command as fiction — re-read at the moment of removal.
- **Every retirement gate can PASS on a worktree in active use** — nothing catches a live PROCESS. Two signals see what the gates cannot: the newest mtime under `.next/`, and HEAD moving between the gate read and the removal. Read the tip at the GATE and reuse that SHA.
- **Closing a session does NOT release its worktree, and the release is not INSTANT** — `git worktree remove` then fails *Permission denied*, deregisters anyway, and leaves the husk. **The holder IS findable** (`scripts/find-worktree-holder.ps1`), and **`list_sessions` MISLEADS here** — cross-check by BRANCH against every open PR. 🔴 **A holder can be UNKILLABLE — ARCHIVE the owning session, which ends it with NO reboot**; it survives `Stop-Process`, and a reboot is never worth a husk holding no files. A session can NEVER clear its own husk. **NEVER kill git machine-wide.** [docs/agents-session-traps.md](docs/agents-session-traps.md).
- **A DEREGISTERED worktree is worse than a husk — a shell still sitting in it resolves git against the PRIMARY checkout**, silently, so a commit lands on PRODUCTION's branch with no error. **`cd` cannot escape it** — address the real repo with `git -C <path>`. **Path-filtered reads LIE there, and a POSITIVE CONTROL does NOT catch it**: the read can come back EMPTY, but it can also SUCCEED with the PRIMARY's copy of a path that lives in both, and that half has no tell — a control proves resolution WORKS, never WHICH repository answered. The one reliable check is `git rev-parse --show-toplevel`. [docs/agents-session-traps.md](docs/agents-session-traps.md).
- **A squash-merged branch reads as "on NO origin ref" — that means BACKED UP, not stranded.** Never push a merged branch to "rescue" it; `git branch rescue/<name> <tip>` is the zero-risk move.
- **Self-removing a worktree MUTES its own session-end guard — and a `.claude/worktrees/` one canNOT retire itself at all.** `ExitWorktree` no-ops on a worktree it did not create that session, and `change_directory` refuses to move a pinned session, so its own cwd holds the folder. **So strip the payload FIRST, while you still can**: drop the junction with cmd's NON-recursive `rmdir` (never `Remove-Item -Recurse`, which can follow it into the primary), then `.next`. Only a ZERO-file husk is what `--fix` will clear.
- **`next dev` in a worktree needs the explicit `--webpack` flag** — TURBOPACK rejects the §5 junction, not Next; `pnpm run dev` now chooses for you (`scripts/dev-server.mjs`). **The watchdog's 6 GB kills were a THRESHOLD problem, not a bundler trait**, and `--max-old-space-size` is a measured no-op because the growth is off-heap. 🔴 **Since 2026-09-12 `mem-watchdog.ps1` does not touch a dev server at all** — nothing to tune; it reclaims NODE JOBS, and `dev-server-reaper.mjs` stops the one the ENDING session started.
- **`gh pr merge` from a worktree exits NON-ZERO after the merge SUCCEEDED.** `fatal: 'main' is already used by worktree` is its LOCAL post-merge step, never the merge, and it fires on EVERY merge here since the primary holds `main`. Treat a non-zero exit as UNKNOWN, not failed: `gh pr view <n> --json state,mergeCommit`; `MERGED` means done. Never retry — that errors on an already-merged PR and reads like a worse failure. `gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded`

**Next.js runtime**

- **A >2MB `unstable_cache` entry KILLS the dev server** — throws only in dev, uncatchable, muted in prod.
- **`unstable_cache` SERIALIZES, so a returned `Map` comes back `{}`** — the page works on exactly ONE render, then throws for the whole revalidate window, rendered as the admin error boundary (which reads as a permission redirect). Cache the ROWS.
- **Standalone tracing copies FILES, not pnpm SYMLINKS**, and **a top-level `import sharp` 500s a whole PAGE** when the `.so` is missing.

**Browser and dev-auth**

- **A MINIMIZED window makes every browser reading LIE — check `document.visibilityState` FIRST.** rAF stops entirely, so **dnd-kit cannot run at all** while plain `.click()` still works. `javascript_tool` does not await a returned promise, and the isolated world cannot see React fibers.
- **A COLLAPSED PANE is worse than a minimized window: the page sticks on "Loading workspace" and EVERY element measures 0** — server 200, content in the DOM, widths zero. Next streams it as a `<div hidden>` whose reveal is rAF-gated, so `style.display` LOSES to `[hidden]`: remove the ATTRIBUTE, and find that wrapper by what it CONTAINS. Carry a POSITIVE CONTROL — `innerWidth`/`main.clientWidth` must equal the size you emulated. Only the app's own UI opens the pane. `collapsed-browser-pane-reads-zero`
- **Click by TEXT — blind coordinate clicks once fired a real production collection run.**
- **Dev login is `GET /api/dev-auth?role=<Role>`, and it DOES role-switch the Browser pane** via an httpOnly cookie. **It DOES take `hrId`** — `?role=National%20Sales%20Manager&hrId=a-12&next=<path>` signs you in as THAT person, the only way to verify anything scoped to one manager's team. **Header-only is the SEPARATE `x-phoenix-*` path**, which the pane cannot set; that is what role SWEEPS use.
- **Turbopack 500s with `0xc0000142` when the commit charge is exhausted** — close a session, do not debug the code.
- **Verify a 375px mobile layout with NO dev server.**

**Machine ceiling**

- **A freeze leaves NO dump** — an EMPTY Windows Minidump folder is the EXPECTED signature, and the tell is `dwm.exe` dying `0xC00001AD`. The ceiling is FREE RAM, not commit — the pagefile is fixed at 64 GB, so commit rarely binds (measured 2026-09-17); §5 carries the mechanics and the live-read rule. **Never judge a process by `VirtualSize`.**
- **Two decoys sit on that diagnosis:** `nvlddmkm` is what dies when the compositor is starved, not the cause; but the `node.exe` figures in **Event 2004 ARE real**. The largest leak so far is a throwaway ExcelJS probe (22 → 41 GB in 40s, off-heap). Delete such probes when done.
- **An interrupted session leaves the tree BROKEN ON PURPOSE.** Before acting on a bare "commit it", `git grep BREAK-`.
- **A SLOW REPLY IS THE EFFORT LEVEL, NOT THE MACHINE** — `max` got slow and `xhigh` is the balance, so read the session's effort before blaming RAM, the box or the session count. `claude-code-effort-max-got-slow-xhigh-is-the-balance`
- **A slowness audit dates the CHANGE — it never quotes a snapshot.** One reading proves nothing here; measure before and after the thing you suspect, or the number attributes itself to whatever was open at the time. `slowness-audits-compare-before-and-after`
- **`Agent` with `isolation: "remote"` from a desktop session can run LOCALLY, with no notice of the fallback** — the helper lands in `.claude/worktrees/agent-<id>` on this laptop, so it is no way past the RAM floor. Read the helper's own reported paths before telling the owner work ran in the cloud: an `F:\` path means it did not. `agent-isolation-remote-ran-locally-in-a-worktree`
