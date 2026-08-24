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

### 2.1 Session-level traps (relocated from the memory index, 2026-08-23)

These are **agent-operating** facts, not Phoenix business rules. They lived in `MEMORY.md`, which the
memory loader truncates at **24,400 bytes** — past that the tail is silently dropped and the last
entries stop existing. This file has no such cliff and auto-loads in full via `CLAUDE.md`'s
`@AGENTS.md`, so these belong here: same reach, plus review and version control. Each names the memory
file holding the full account, under
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\`.

**Shell and tooling**

- **`grep -r` hangs on this checkout — use `git grep` or `rg`.** Worktree payload is ~1.9M paths; tools
  honouring `.gitignore` never see it. `shell-grep-unusable-use-git-grep-or-rg`
- **`pnpm run <script>` tries to PURGE `node_modules`** when the lockfile has moved, destroying the
  install before the script runs. Invoke directly: `node scripts/repo-doctor.mjs`.
  `pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved`
- **`git show <ref>:<path>` returns EMPTY under MSYS** — the colon path is mangled. Use the PowerShell
  tool. `git-ref-colon-path-is-mangled-by-msys-returns-empty`
- **A role probe cannot trust the HTTP status code**, and **a POST to ANY `/api/**` path returns 403
  even when the route does not exist** — probe a deploy with GET and read 404/405/403.
  `a-role-probe-cannot-trust-the-http-status-code` ·
  `a-post-to-any-api-path-returns-403-even-if-it-does-not-exist`

**Git**

- **Deleting a branch does not remove its pushed commit**, and **reusing a squash-merged branch makes a
  conflicting PR.** `deleting-a-branch-does-not-remove-a-pushed-commit` ·
  `reusing-a-squash-merged-branch-makes-a-conflicting-pr`
- **`git push` to origin hangs — kill it at ~60s and retry immediately.** A push or fetch that dies with `fatal: Out of memory, malloc failed (tried to allocate 524288000 bytes)` was never a real memory fault or a network problem: `http.postBuffer` was set to 500MB in `.git/config` and git allocates the whole buffer up front, so it died before sending a byte whenever free RAM dipped under it. **Fixed 2026-08-23 — that key is now `8388608` (8MB), verified with an unoverridden fetch, ls-remote and push.** Do NOT restore 500MB; if a genuine large-push failure ever appears, raise to 50MB at most. `git-push-to-origin-hangs-retry-immediately` · `git-push-oom-is-a-500mb-postbuffer-in-repo-config`
- **A merge to `main` mid-session silently orphans your next push.**
  `a-merge-mid-session-orphans-your-next-push-silently` · `two-sessions-fixed-one-bug-main-was-never-ci-validated`
- **Deleted branch tips and stashes live under `refs/deleted-*` and are the ONLY copy — never pushed.**
  `git for-each-ref 'refs/deleted-*'` reads **0** because `*` never crosses `/`; use the full prefix
  `'refs/deleted-*/**'`. Verified 2026-08-23: **44** refs (34 branch tips, 10 stashes). Count it live
  before believing any number. `deleted-branch-tips-live-in-refs-deleted-branches`
- **An empty `git log <branch> --not --remotes=origin` is NOT proof a branch is safe to delete.** A
  squash merge deletes the remote branch, but `git fetch` never prunes — so `refs/remotes/origin/<branch>`
  survives at the branch's OWN tip and the check compares the branch against itself, returning empty
  forever. Confirmed again 2026-08-23: it read empty while `git ls-remote --heads origin <branch>`
  returned **0** lines; the `git remote prune origin` that followed cleared **8** such ghosts at once.
  Gate deletion on the merged PR. And when the blobs DO differ from `main`, that is a question not a
  verdict — name the later commit with `git log <squashSHA>..origin/main -- <files>` before calling
  anything stranded. `not-remotes-flips-when-remote-refs-are-pruned` ·
  `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **`git` "Authentication failed" can be the credential HELPER (GCM) going OOM, not a bad token.**
  Git Credential Manager dies at `internal/cpu.doinit` and git then retries ANONYMOUSLY, so the token
  is never presented — the failure is memory pressure, not auth. Look UP the output for a Go panic;
  change NO credentials. `git-auth-failed-can-be-the-credential-helper-going-oom`

**CI and PRs**

- **CI jobs failing in SECONDS mean billing, not code.** `ci-jobs-failing-in-seconds-means-billing-not-code`
- **`secret-scan` is a required check — there are 4 total**, because a personal account has no GHAS/OSS
  scanning. `github-personal-account-no-ghas-oss-scanning`
- **`gh pr checks` LAGS behind the real job state.** `gh-pr-checks-lags-behind-the-real-job-state`
- **`check-runs: 0` also means CONFLICTED** — a conflicted PR runs no CI at all, which reads as "not
  started". `a-conflicted-pr-runs-no-ci-at-all`
- **ONE new hub page trips FOUR separate CI gates.** `adding-a-hub-page-trips-four-separate-ci-gates`
- **A red `main` still builds, ships, and serves perfectly** — `ignoreBuildErrors` (see the
  exhaustive-`Record` entry under Validation below) hides it from the product, and a green PR is not
  a green `main`: two PRs can each pass alone, on checks taken before the other existed, then merge
  and never get validated together. After merging, check the run on **`main`'s new head**
  (`gh run list --branch main --limit 5 --json headSha,name,status,conclusion`), not the branch's own
  check. `a-red-main-ships-and-looks-fine-build-ignores-type-errors`

**Migrations**

- **A migration FILE written is not a migration APPLIED**, and **a merged migration file does not mean
  the grants are live.** `migration-file-written-is-not-migration-applied` ·
  `merged-migration-file-does-not-mean-grants-are-live`
- **Migration timestamps COLLIDE across parallel branches**, and **the ledger version never matches the
  filename.** `migration-timestamp-collides-across-parallel-branches` ·
  `migration-ledger-version-never-matches-the-filename`
- **A PostgREST `.in()` carrying several hundred ids returns ZERO rows and NO error.** The filter goes
  in the URL, so past some length the result comes back `{ data: [], error: null }` — an empty set
  indistinguishable from a true answer. On 2026-08-25 a 409-id `.in()` reported "never read: 409 of
  409" and "0 have a stored file"; chunked at 50 the truth was **10**. Chunk every `.in()` at ~50, and
  print the row count of the intermediate fetch — a pool of 409 candidates cannot return 0 extraction
  rows, which is what exposed it. `postgrest-in-with-hundreds-of-ids-silently-returns-nothing`

**Validation**

- **A test name appended beside an existing one in `tests/run-tests.ts` becomes an ARGUMENT, not a
  registration** — `runTest(name, fn)` takes exactly two, so the third silently never runs; #2357
  escaped only because the surplus argument was also a `TS2554`. One `await runTest(name, fn)` per
  test (`docs/testing.md` step 5). Check by AST, not a local `tsc`: 883 `runTest` calls, all 2-arg,
  the new fn a second argument exactly once — a comma count cannot work, the names are long prose.
- **RAM-saturated? WAIT — do not skip validation for it.** `dont-skip-validation-for-ram-wait-instead`
- **Source-pinning tests slice a fixed BYTE window and false-FAIL** when the file shifts.
  `source-pinning-tests-slice-a-fixed-byte-window`
- **A heredoc eats backslashes** and yields a test that only ever passes.
  `heredoc-eats-backslashes-and-makes-a-test-that-only-passes`
- **`parseDiagnostics` is SYNTAX-ONLY — it cannot see a typecheck error.**
  `parse-diagnostics-cannot-see-a-typecheck-error`
- **`setState` inside `useEffect` is a lint ERROR here.** `set-state-in-effect-is-a-lint-error-here`
- **A green TEST run carries NO type signal.** `pnpm run test` strips types and never typechecks, so
  a passing suite says nothing about type errors — only the PR's `typecheck` job answers.
  `a-green-test-run-carries-no-type-signal-at-all`
- **An exhaustive `Record` does NOT gate the build.** `next.config` sets
  `typescript: { ignoreBuildErrors: true }`, so a `Record<SomeUnion, X>` missing a key compiles,
  builds and DEPLOYS; only the PR's `typecheck` job sees it, and `strict: false` lets a PR merge on
  a check taken before the union grew. On 2026-08-24 #2395 added a ninth role family 4 minutes after
  #2396 added a `Record` over every family — neither CI run saw the other, and production served
  `bandByFamily["sales"] === undefined` -> **NaN sort keys**, which do not throw: 63 real candidates
  scattered at random through the screening queue and every band counter read 0. `main` was red 15
  minutes. Back any such `Record` with a RUNTIME assertion in a registered test — iterate the union,
  assert the looked-up value is real (`Number.isFinite`), and assert no key outside the union
  appeared. `an-exhaustive-record-does-not-gate-the-build-here`

**Worktrees** (see also §5)

- **Another SESSION can remove a worktree under you.** `another-session-can-remove-a-worktree-under-you`
- **A gitignored `_wt-*/` scratch folder makes a worktree look clean.**
  `gitignored-wt-scratch-makes-a-worktree-look-clean`
- **The pre-push gate is GONE — a bare worktree pushes fine** (verified 2026-08-24: `.git/hooks`
  holds only `pre-push.bak-20260730`). What a bare worktree cannot do is RUN a suite; junction
  `node_modules` from the primary for that, invoke `node` directly, and never `pnpm` inside it.
  `bare-worktree-cannot-push-pre-push-gate-needs-node-modules`
- **"Permission denied" on `git worktree remove` still DEREGISTERS the worktree.**
  `worktree-remove-permission-denied-still-deregisters`
- **`--fix` / `--strip-idle` need exactly ONE live session**, and **`--fix` can NEVER clear a `_wt-*`
  husk** — `fs.rmSync` EPERMs on dangling pnpm junctions. Use `rmdir /s /q`, then re-check the folder:
  an OLD `CreationTime` proves it never went. `repo-doctor-strip-idle-cannot-run-with-sessions-open` ·
  `repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm`
- **repo-doctor's RETIRABLE verdict names the branch a folder HAD at scan time** — a parallel session
  can repoint the tree first, and the report prints a paste-ready `git worktree remove` beside it, so
  `--force` eats the new branch's work. Re-read `status -sb -uall` and `git log origin/main..HEAD` in
  the worktree at the moment of removal, never the report: on 2026-08-23 one listed retirable on merged
  #2362 sat on a NEW branch with 90 uncommitted lines and an unpushed migration, and opened #2364.
- **A squash-merged branch reads as "on NO origin ref" — that means BACKED UP, not stranded.**
  `delete_branch_on_merge` is ON, so GitHub deletes the branch's own remote ref at merge and pure
  reachability then calls every successfully merged worktree unbacked-up. repo-doctor did exactly
  that until 2026-08-24, printing a STOP that told you to **push** the branch — which is how you get
  a conflicting PR, and a conflicted PR runs no CI at all. It now asks about CONTENT
  (`scripts/repo-doctor-unpushed.mjs`, pinned by `tests/repo-doctor-unpushed-commits.test.ts`):
  the branch's CUMULATIVE diff from its merge base against each upstream commit's patch-id, plus
  `git cherry` for anything cherry-picked or rebased on its own. Both are needed — `git cherry`
  alone marks every commit of a MULTI-commit squash `+` "not upstream", which is what makes the old
  advice look sound right up until it is not. To check an OLD report by hand, compare
  `git diff <mergeBase> <tip> | git patch-id --stable` with the merge commit's; comparing the tip
  commit alone only works when the PR carried exactly one commit. Never push a merged branch to
  "rescue" it; `git branch rescue/<name> <tip>` keeps the tip locally at zero risk.
  `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **Self-removing a worktree MUTES its own session-end guard.**
  `self-removing-a-worktree-mutes-its-own-session-end-guard`

**Next.js runtime**

- **A >2MB `unstable_cache` entry KILLS the dev server** — it throws only in dev, is uncatchable, and is
  muted in prod. Gzip rows; return null over the ceiling.
  `next-2mb-data-cache-throws-only-in-dev-and-kills-the-server`
- **Standalone tracing copies FILES, not pnpm SYMLINKS** (fixed 2026-08-22 with a hoist plus a `*/**`
  glob, now CI-gated), and **a top-level `import sharp` 500s a whole PAGE** when the `.so` is missing.
  Load native modules on demand and assert at BUILD. `next-tracing-copies-files-not-pnpm-symlinks` ·
  `next-standalone-trace-misses-a-native-librarys-so-dependency`

**Browser and dev-auth**

- **Click by TEXT — blind coordinate clicks once fired a real production collection run.**
  `blind-coordinate-clicks-fired-a-production-collection-run`
- **Dev login is `GET /api/dev-auth?role=`** — it is header-only and the Browser pane cannot use it.
  `dev-auth-is-header-only-browser-pane-cannot-use-it`
- **Turbopack 500s with `0xc0000142` when the commit charge is exhausted** — close a session, do not
  debug the code. `turbopack-500s-with-0xc0000142-when-commit-is-full`
- **Verify a 375px mobile layout with NO dev server.** `verify-a-mobile-layout-without-a-dev-server`

## 3. Stable Environment Facts

History and verification detail: [docs/agents-incident-history.md](docs/agents-incident-history.md).

- Production application: `https://phoenix-hr.satopharma.com` — **served by Railway since 2026-08-01, no longer Cloud Run.** Railway service `phoenix-people-workforce`, project `Phoenix-HR-Workforce`, environment **`production`**, region **`europe-west4-drams3a` (Amsterdam, EU West)**, 1 replica. **The region is deliberately colocated with the Frankfurt Supabase project (`eu-central-1`) and near the Cairo users — if production is ever re-platformed, it must stay in Europe** (measured: ~204ms from `sfo` vs ~75ms from `europe-west4`). Also reachable at `https://phoenix-people-workforce-production.up.railway.app`; Cloudflare holds `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied.
- **The `production` Railway environment's service now tracks git branch `main` directly** (repointed 2026-08-13 via `railway service source connect --environment production --branch main`). Before that it was source-configured to track a git branch literally named `staging`, which had gone stale — so five already-merged, already-CI-green PRs (#2093, #2095, #2094, #2098, #2097) sat unshipped in production for hours while `main` moved on, with no error or signal anywhere. **Do not assume "merge to `main` ships to production" without first confirming the Railway `production` environment's service source branch** (`railway status --environment production --json`, check `.environments.edges[0].node.serviceInstances.edges[].node.latestDeployment.meta.branch`) — the source can drift from `main` again with zero warning, since GitHub shows the merge as normal either way.
- **GCP is DEAD, not standby.** Billing closed 2026-08-01; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`. Do not "verify production" against Cloud Run. `deploy-cloud-run.yml` / `deploy-cloud-run-staging.yml` are trigger-disabled but intact.
- **The production scheduler is the third-party `cron-job.org`.** Automation is **running, not stalled**: daily notifications, the outbox drain, and iReports sync/reconcile all fire from that account. The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** — a red herring, not proof anything is down. **Do not tell the owner notifications/outbox/iReports are stalled without checking `cron-job.org` first.** It caps request timeout at 30s, so a long route logs a false `Failed (timeout)` while the server still finishes the work. `src/lib/cron-control/*` is a dashboard over the dead GCP scheduler and remains inert.
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
- **`git worktree remove` leaves a HUSK, and nothing built into git can see it.** It deletes tracked files and the registry entry but leaves the gitignored payload — `node_modules/` and `.next/` — on disk. What remains has no `.git` file and no registry entry, so `git worktree prune` cannot find it and the SessionEnd leg of `.claude/hooks/worktree-exit-guard.mjs` exits early because `git rev-parse --git-dir` resolves nothing. Husks therefore accumulate forever and are invisible to every "list the worktrees" check. **The backup check no longer depends on that leg:** since 2026-08-23 `bash-guard.mjs` hands any removal-shaped command to `worktree-exit-guard.mjs --pre-removal`, which reports unpushed commits and uncommitted files and writes them to `.claude/worktree-exit.log` *before* the directory is deleted. It never blocks. The SessionEnd leg had been silent for a full day while three worktree sessions ended, with the hook still registered and the script still on disk — silence was its only symptom. **Run `pnpm run repo:doctor`** ([scripts/repo-doctor.mjs](scripts/repo-doctor.mjs)) after any removal: it reports by default, `--fix` deletes only husks proven to hold zero files, and it refuses to act while more than one Claude Code session is live. Anything holding even one file is reported NEEDS REVIEW and never touched.
- **A memory file with no index line is invisible, not merely hard to find** — only `MEMORY.md` loads automatically, so nothing recalls an unlinked file and the next session re-derives what it already knows. A sweep on 2026-08-19 found **194 of 734** in that state, the oldest unlinked since May. `pnpm run repo:doctor` now reports them (and pointers whose file is gone) in a MEMORY INDEX section; `--deep` lists every one instead of the first 20. It is read-only and never changes the exit code — deciding whether an orphan earns a line in `MEMORY.md`, a line in `MEMORY-ARCHIVE.md`, or retirement is a judgement about what is still true.
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
