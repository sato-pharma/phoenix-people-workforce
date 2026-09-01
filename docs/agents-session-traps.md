# Session-level traps — the full account

This is the detail behind the hooks in [AGENTS.md](../AGENTS.md) §2.1. **The hook there is the cue;
this file and the memory files it names are the fact** — the same split `MEMORY.md` states in its own
first line, applied one level up.

**Why the detail lives here and not in `AGENTS.md`.** `CLAUDE.md` pulls `AGENTS.md` in via
`@AGENTS.md`, in full, on every single request. That is the right home for a one-line hook, which has
to be seen *before* a session knows it needs it. It is the wrong home for a multi-paragraph incident
write-up, which is only wanted once a session is already looking. Between 2026-08-19 and 2026-08-29
`AGENTS.md` grew 32KB → 147KB, and §2.1 alone reached 58KB of the 147 — roughly 15,000 tokens of
fixed context occupancy, re-sent on every request, which is context the conversation no longer had.
Compaction got more frequent in exact proportion. Splitting hook from detail is what `MEMORY.md`
already does under its 22,000-byte budget; §2.1 had simply never had a budget of its own.

**Nothing here was rewritten, with one correction.** The body below is the verbatim §2.1 text as it
stood at `fe750dbdf`, including every measurement, date and PR number. The one exception, made
2026-08-29 and flagged inline at both sites: #2617 attached the memory slug
`a-mock-name-generator-reproduces-real-employee-names` to two traps that file does not describe —
the multi-statement `execute_sql` trap and the `au.occupancy_history` hr_id trap. Both citations are
removed, because a pointer that lands a session on the wrong record costs more than no pointer at
all. **Read the verbatim claim as provenance, not as licence to restore them.**

**Reading order.** Find the hook in `AGENTS.md` §2.1, then search this file for its wording. Groups
below, in order: Shell and tooling · Git · CI and PRs · Migrations · Database, grants and RLS ·
Probing, attributing and reporting production · Validation · Memory and this index · Parallel
sessions · Worktrees · Next.js runtime · Browser and dev-auth · Machine ceiling.

---


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
- **`git show <ref>:<path>` returns EMPTY under MSYS**, and **`grep -c $'\r'` matches EVERY line of a pure-LF file** — use the PowerShell tool, or count raw bytes in node. A CRLF working copy can read as CLEAN too: git normalises before comparing. **MSYS mangles a SEARCH PATTERN the same way: a `git grep`/`rg` pattern holding a leading-slash path matches NOTHING, silently** — `redirect("/employee-portals/` returned 0 against 41 real hits, and a zero here reads as *the code is clean*. Export `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` before any such sweep, and never quote a count from one without it. `git-ref-colon-path-is-mangled-by-msys-returns-empty`
- **`grep -c $'\r'` under MSYS reports a match on EVERY line of a pure-LF file, and a working copy can
  carry CRLF that `git status` calls clean.** Two separate faults that present as one argument, and
  between them they cost two sessions two rounds on 2026-08-29. The instrument first: MSYS translates
  line endings on read, so the `\r` pattern matches everywhere and the count equals the line count —
  it cannot distinguish LF from CRLF and its answer is always "CRLF". Never settle a line-ending
  question with a shell tool here; count bytes 13 and 10 from a raw Buffer in node
  (`fs.readFileSync(p)` — no encoding argument, so no text-mode translation) or use the PowerShell
  tool. The second fault is the one the bad instrument hid. `.gitattributes` pins `* text=auto eol=lf`,
  which governs what git **writes on checkout** — it does not govern what a local tool writes
  afterwards, and git then normalises on **read** before comparing, so the modification is invisible:
  `git status --porcelain -- CLAUDE.md` was EMPTY against a working copy of **6,924 bytes with 106 CRLF
  pairs** while the blob was **6,818 with zero CR**. It is selective, which is the tell that a writer
  and not a checkout is responsible: in that worktree `CLAUDE.md`, `.claude/agents/role-sweeper.md` and
  `.claude/hooks/bash-guard.mjs` carried CR while `AGENTS.md` beside them did not. **This moves a real
  number** — auto-loaded context is measured in bytes, so the same file legitimately has two honest
  sizes, one for the commit and one for what a given machine actually loads; a byte-budget gate should
  answer for the commit and discount the CR of a CRLF pair, while a reporter should say what the
  machine in front of it loads. Neither figure is wrong, and making them agree by lying about the
  second is. **The generalisable half is about method, not line endings: a wrong instrument tells you
  nothing about the conclusion.** Both readings here were true at once — the `grep` evidence was
  genuinely garbage *and* the CRLF copy was genuinely real — so dismissing the claim on the strength of
  the broken tool was the actual mistake. When you catch a tool lying, that discredits the tool and
  returns the question to open, not to answered-in-your-favour. **No memory file holds this trap, and
  this account is the record.**
- **A role probe cannot trust the HTTP status code**, and **a POST to ANY `/api/**` path returns 403
  even when the route does not exist** — probe a deploy with GET and read 404/405/403.
  `a-role-probe-cannot-trust-the-http-status-code` ·
  `a-post-to-any-api-path-returns-403-even-if-it-does-not-exist`
- **`curl -d "@-"` creates NOTHING on Windows** — the stdin-payload form silently posts an empty body,
  so a cron-job.org REST call "succeeds" having made no job. Write the JSON to a file and pass
  `-d @file.json`. `cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui`
- **Reads of `.env*` are auto-approved here — deliberately, for EVERY key, not just `NEXT_PUBLIC_`.**
  The owner was shown the `SUPABASE_SERVICE_ROLE_KEY`/`DATABASE_URL` exposure explicitly and chose the
  broad option; do not re-litigate it or narrow it back on your own judgement. It is licence to
  *inspect*, never to *propagate* — §9's do-not-repeat-a-secret rule is unchanged, and a truncated
  check beats a full dump. `env-file-reads-fully-auto-approved-2026-08-09`
- **A Claude permission allow-rule stores the LITERAL command, so an inline env var bakes a live
  credential into `settings.local.json` in plaintext.** A working Telegram bot token sat there in the
  clear; the file is gitignored, so secret-scanning and CI never see it. Grep any `settings.*.json`
  for `TOKEN=`/`KEY=`/`SECRET=`/`PASSWORD=` before copying, merging, sharing or committing it, merge
  `allow`/`deny`/`ask` bucket by bucket (a flattened union promotes a `deny` into `allow`), and prefer
  a wildcard rule over an inline-secret one. `permission-allowlist-rules-can-embed-a-live-secret`
- **`mcp__supabase-staging__*` is broken — empty `list_projects`, permission error on `get_project`.**
  That is the SERVER's own auth, not the staging database, which was healthy. Route staging work
  through `mcp__supabase-production__*` passing the staging `project_id` (§8: the `project_id`
  argument is the only thing separating the two). `supabase-staging-named-server-broken-2026-08-10`
- **The Supabase MCP returns ONLY the last result set of a multi-statement `execute_sql` — every
  earlier one vanishes with no error.** Measured on production 2026-08-29: three `select`s in one
  call, separated by semicolons, returned exactly one row, the third. Nothing anywhere reports that
  two result sets were discarded. So a batch written as "count A; count B; now show C" silently
  answers only C, and — the dangerous shape — a verification block that checks its own work in
  statement one and prints a summary in statement two certifies whatever the summary happened to
  say, having never shown you the check. Put every question in ONE statement (CTEs or scalar
  subqueries, as the occupancy proof below did), or make a separate call per question.
  **No memory file holds this trap, and this account is the record.** #2617 cited
  `a-mock-name-generator-reproduces-real-employee-names` here, which is a record of the staging
  anonymisation scrub this was noticed *during* — the name-collision method, not the MCP's
  behaviour. Do not re-add that citation.
- **A Windows USER env var SHADOWS every `.env.local` in every worktree, silently.** `node --env-file`
  / `--env-file-if-exists` only FILLS IN variables that are missing — it never overwrites one already
  in the process environment. So editing `.env.local` and re-running changes nothing, with no warning.
  **Which copy is valid has already flipped once**, hours apart on the same day: the env var was the
  dead key shadowing a good file at 10:00 Cairo and the only live key by 12:35, with three distinct
  164-char `OPENAI_API_KEY`s in play at once. Never reuse a previous session's answer — re-probe
  process env, `.env.local` and the Windows User env, all three, and never print the value.
  `windows-env-var-shadows-every-env-local-key`
- **The local attendance agent dies at EVERY logon and loses NOTHING — do not escalate it.** The
  `Phoenix Attendance Agent - Run At Logon` task ends `0xE0434352` (an unhandled managed exception)
  every single boot, but `Phoenix Attendance Sync - Every 2 Hours` starts the agent on demand and
  those runs INSERT — 19 rows and 1 row on 2026-08-26 off 5,406 device records. Overnight `503`s are
  the DEVICE, not the code (`192.168.100.52:4370` is reachable roughly 11:00–18:00 Cairo). **Never
  disable the 2-hourly task, and never launch a second agent — it can fire a PRODUCTION sync.**
  `attendance-agent-crashes-at-logon-but-loses-no-attendance`
- **ExcelJS emits two schema-invalid OOXML fragments, so Excel silently REPAIRS the workbook**
  (relocated from `MEMORY.md` 2026-08-28 together with its index line). The symptom is the "We found
  a problem with some content" dialog, logging *"Replaced Part: /xl/worksheets/sheetN.xml"* and
  *"Repaired Records: Drawing"*. **1 —** `CT_SheetPr` fixes the child order `tabColor`, `outlinePr`,
  `pageSetUpPr`; setting `outlineProperties` together with `pageSetup.fitToPage` makes ExcelJS write
  `<pageSetUpPr/>` **before** `<outlinePr/>`, and Excel then discards the ENTIRE sheet part — only
  the sheets carrying an outline group fail, which is the tell. **2 —** `CT_OneCellAnchor` declares
  no attributes at all, yet ExcelJS writes `editAs="oneCell"` on `<xdr:oneCellAnchor>` **whether or
  not you pass it**, so dropping the option from `ws.addImage` does NOT fix it. Both need the `.xlsx`
  zip post-processed. Four diagnosis traps cost real time: a clean `zipfile.testzip()` proves nothing
  (the container was always fine — parse the part XML), a non-greedy `<sheetPr\b.*?(?:/>|</sheetPr>)`
  regex stops at the first `/>` and makes a correct file look broken, openpyxl reports `images: 0` on
  every sheet because it cannot read ExcelJS DrawingML (check `xl/media/*` instead), and openpyxl
  under-reports grouped columns. `exceljs-writes-two-schema-invalid-ooxml-fragments`

**Git**

- **Deleting a branch does not remove its pushed commit**, and **reusing a squash-merged branch makes a
  conflicting PR.** `deleting-a-branch-does-not-remove-a-pushed-commit` ·
  `reusing-a-squash-merged-branch-makes-a-conflicting-pr`
- **`git push` to origin hangs — kill it at ~60s and retry immediately.** A push or fetch that dies with `fatal: Out of memory, malloc failed (tried to allocate 524288000 bytes)` was never a real memory fault or a network problem: `http.postBuffer` was set to 500MB in `.git/config` and git allocates the whole buffer up front, so it died before sending a byte whenever free RAM dipped under it. **Fixed 2026-08-23 — that key is now `8388608` (8MB), verified with an unoverridden fetch, ls-remote and push.** Do NOT restore 500MB; if a genuine large-push failure ever appears, raise to 50MB at most. `git-push-to-origin-hangs-retry-immediately` · `git-push-oom-is-a-500mb-postbuffer-in-repo-config`
- **A merge to `main` mid-session silently orphans your next push.**
  `a-merge-mid-session-orphans-your-next-push-silently` · `two-sessions-fixed-one-bug-main-was-never-ci-validated`
- **`refs/deleted-*` is the ONLY copy of an archived branch tip or stash — never pushed — but it is
  NOT automatic, and this entry implied it was until 2026-08-27.** The glob trap is real and
  unchanged: `git for-each-ref 'refs/deleted-*'` reads **0** because `*` never crosses `/`, so use the
  full prefix `'refs/deleted-*/**'`, and count it live before believing any number (**44** refs on
  2026-08-23, **96** — 86 branches, 10 stashes — on 2026-08-27). What is wrong is the implied safety
  net. **Nothing in this repository writes that namespace**: not `scripts/`, not `.claude/hooks/`
  (`bash-guard`, `session-lock`, `worktree-exit-guard` only), and `.git/hooks` holds nothing live at
  all — just `pre-push.bak-20260730`. A plain **`git branch -D` archives NOTHING.** Measured
  2026-08-27: deleting 6 branches moved the count **96 → 96**, with the newest archived entry still
  hours older than the deletions — the second such measurement, after **44 → 44** on 2026-08-23.
  **So never delete a branch expecting this to catch it.** After a `-D` the tip survives only as an
  **unreferenced object** — recoverable by SHA, so keep the SHA the delete prints, and only until
  `git gc` prunes unreachable objects (default ~2 weeks). To archive a tip deliberately, write the
  ref yourself *before* deleting: `git update-ref refs/deleted-branches/<name> <sha>`. **And
  `refs/deleted-*` is not the only archive — `refs/backups/*` lives ON ORIGIN**, written by
  `scripts/prune-stale-branches.ps1`, pushed, and therefore the only copy that survives losing this
  laptop: `git ls-remote origin 'refs/backups/*'`. Check both before calling a tip lost.
  `deleted-branch-tips-live-in-refs-deleted-branches`
- **An empty `git log <branch> --not --remotes=origin` is NOT proof a branch is safe to delete.** A
  squash merge deletes the remote branch, but `git fetch` never prunes — so `refs/remotes/origin/<branch>`
  survives at the branch's OWN tip and the check compares the branch against itself, returning empty
  forever. Confirmed again 2026-08-23: it read empty while `git ls-remote --heads origin <branch>`
  returned **0** lines; the `git remote prune origin` that followed cleared **8** such ghosts at once.
  Gate deletion on the merged PR. And when the blobs DO differ from `main`, that is a question not a
  verdict — name the later commit with `git log <squashSHA>..origin/main -- <files>` before calling
  anything stranded. `not-remotes-flips-when-remote-refs-are-pruned` ·
  `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **A UTC merge time read against a Cairo commit time INVERTS the merged/stranded verdict.** §4's
  "report in Africa/Cairo, never raw UTC" is a REPORTING rule; this is the ANALYSIS failure it does
  not cover, and it is what makes the two traps above dangerous. `gh pr view --json mergedAt` returns
  **UTC** (`2026-08-28T09:51:22Z`) while `git log --format=%cI` returns **Cairo**
  (`2026-08-28T12:44:26+03:00`). Side by side, 12:44 looks LATER than 09:51, so squash residue reads
  as new post-merge work — but 09:51Z **is** 12:51 Cairo, and that commit predates its own merge by
  seven minutes. Measured 2026-08-28 on a peer session's worktree audit: combined with `ls-remote` =
  **0** (which is `delete_branch_on_merge` succeeding, not a missing backup) and `git cherry`'s
  multi-commit-squash false positive, it produced a confident STOP telling two sessions to **push**
  already-merged branches — the exact move that opens a conflicting PR, and a conflicted PR runs no
  CI at all here. Each signal is ambiguous alone; the timestamp is what *appears* to resolve them,
  and it resolves them backwards. **Compare instants, never wall clocks** — put both sides in one
  zone (`TZ=UTC git log`) before subtracting. And a timestamp is never the verdict anyway: the answer
  is CONTENT, per §5 — `git diff $(git merge-base origin/main <branch>) <branch> | git patch-id
  --stable` against the squash commit's own patch-id. Identical means fully represented on `main`,
  whatever the clocks appear to say.
  `a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal`
- **`git` "Authentication failed" can be the credential HELPER (GCM) going OOM, not a bad token.**
  Git Credential Manager dies at `internal/cpu.doinit` and git then retries ANONYMOUSLY, so the token
  is never presented — the failure is memory pressure, not auth. Look UP the output for a Go panic;
  change NO credentials. `git-auth-failed-can-be-the-credential-helper-going-oom`
- **`F:\PHX backup` is the disaster-recovery set, and a bundle restore silently returns ZERO refs
  without `core.longpaths`.** Phoenix's cloud side (Railway, Supabase, GitHub) survives a PC reset;
  this set exists for the local support layer, which does not — Claude memory, every `.env*`, the git
  bundle, the scheduled tasks, the attendance agent. Three copies: `F:\PHX backup`, a SHA256-verified
  USB, and an encrypted 7-Zip on Google Drive. **Restoring `06-git\phoenix-ALL-REFS.bundle` needs
  `git config core.longpaths true` FIRST**: Codex CLI writes refs past Windows' 260-char limit, git
  transfers every object then rolls the whole ref batch back on the first one, so a perfect bundle
  reads as 0 refs with no useful error — measured 0 without the flag, 315 with it. Three of its
  sections hold LIVE keys, so treat the set itself as a secret. `phx-backup-disaster-recovery-set`

**CI and PRs**

- **CI jobs failing in SECONDS mean billing, not code.** `ci-jobs-failing-in-seconds-means-billing-not-code`
- **`secret-scan` is a required check — there are 4 total**, because a personal account has no GHAS/OSS
  scanning. `github-personal-account-no-ghas-oss-scanning` **It is the one required check that never
  runs on a `main` push** — `security-scan.yml` is `on: pull_request` + a daily `schedule`,
  deliberately not `push` (Actions cost). Its absence from a merge commit's check-runs is CORRECT,
  not a missed gate: it ran on the PR head against the identical tree. Do not hunt for it after a
  merge, and do not dispatch it to "complete the set".
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
- **Runs NEVER CREATED (`check-runs: 0`, empty `gh run list --branch`) is an Actions OUTAGE, not
  billing — billing creates the run and fails it in seconds; `startup_failure` is an outage
  signature too.** Check `curl -s https://www.githubstatus.com/api/v2/components.json | grep -o
  '"name":"Actions","status":"[a-z_]*"'` and `https://www.githubstatus.com/api/v2/incidents/unresolved.json`
  BEFORE touching the spending limit. Recover a PR with `gh pr close <n> && gh pr reopen <n>` —
  it fires `reopened`, keeps the head SHA, and adds no junk commit. `gh workflow run ci.yml --ref
  <branch>` does NOT fix a PR: a `workflow_dispatch` run's check runs land on the head SHA but
  never enter the PR's `statusCheckRollup`, so branch protection does not count them. Verified
  2026-08-26 — identical check-run names on two heads, only the `pull_request`-sourced ones
  reached the rollup. (Cancelling such a dispatch run is harmless for the same reason.)
- **Simplest PR recovery of all: `gh run rerun <id>` on the PR's OWN `pull_request`-sourced run.**
  A rerun keeps the run's `event` as `pull_request`, so unlike a dispatch its check runs DO enter
  the rollup — and unlike close/reopen it touches nothing about the PR. Verified 2026-08-26 on
  #2418: run `32989112637`, `event=pull_request`, attempt 1 `cancelled` -> attempt 2 `success`,
  rollup populated with all four required checks, `mergeStateStatus` went `BLOCKED` -> `CLEAN`.
  Wait for the backlog to drain first (poll until no `in_progress`/`queued` runs remain), or the
  rerun is just one more racer. Branch protection reads the LATEST check run per name, so a green
  dispatch does not stay green once a newer run of the same name starts.
- **Then WAIT — dispatch lags 20–30 MINUTES during an outage, and the events are NOT dropped.**
  Measured on one PR 2026-08-26: reopen at `16:08:08Z` produced its runs at `16:29:29Z` (+21m); an
  empty-commit push at `16:09:58Z` produced its runs at `16:35:23Z` (+25m). Both ran and passed.
  The earlier claim here that dropped events are "NEVER replayed" was written from the same
  outage, before the queue drained — it is wrong. Polling at 20s/45s/100s and concluding the event
  fired nothing is how that session escalated for no reason: an empty commit, then a whole
  replacement PR, renumbering #2414 to #2419 to escape a problem that was only latency. Fire ONE
  recovery event, then leave it half an hour before believing anything.
- **An extra SHA is not merely useless during an outage — it ACTIVELY KILLS the real head's run.**
  `ci.yml`'s concurrency group is `${{ github.workflow }}-${{ github.ref }}` for a `pull_request`,
  with `cancel-in-progress: true`. On a PR `github.ref` is `refs/pull/<n>/merge` — the SAME value
  for every commit — so both SHAs share one group. When the backlog replays it replays the
  OBSOLETE commit's event too, and that late arrival cancels the run on the head you actually care
  about. Measured on #2418: head `21d25e3a`'s run started `16:34:04Z`, the abandoned `88f468d4`'s
  replayed event landed `16:35:08Z`, and attempt 1 of the head's run ended `cancelled`. It cost a
  full extra CI cycle to recover. Never push an empty commit to force a `synchronize`.
- **`actions/runs?head_sha=` needs the FULL 40-char SHA — an abbreviated one returns `total=0`
  with no error.** During an outage that is indistinguishable from "no runs exist", which is
  exactly when the query gets used: a watcher built on the 8-char form reported no runs for 8
  minutes after they had landed and `gh run list` was already showing them. Same repo, same
  moment: `head_sha=2c0979ca` -> `total=0`, `head_sha=2c0979cae674…` -> `total=2`. Pass all 40
  characters, or filter `gh run list --branch <b>` on `.headSha` yourself.
- **A push to `main` during an outage ships to PRODUCTION with no CI run at all.** Railway deploys
  on push regardless, so the merge is live and unvalidated — and the "green PR is not a green
  `main`" trap above applies with *nothing* having run, not merely with stale checks. On
  2026-08-26 `ad2a0148` and `33f2b5b7` merged a minute apart and neither ever got a run. Recover
  with `gh workflow run ci.yml --ref main` — the `statusCheckRollup` caveat does NOT apply to
  `main`, which is not gated by a PR, so a dispatch is a real answer there.
- **The GitHub repo is `phoenix-people-workforce`; almost everything local is called
  `phoenix-workforce`.** The checkout is `F:\Phoenix Workforce\phoenix-workforce`, `package.json`
  reads `"name": "phoenix-workforce"`, `supabase/config.toml` reads `project_id =
  "phoenix-workforce"`, `.claude/launch.json` names the dev server `phoenix-workforce`, and the
  dead GCP project is `phoenix-workforce-498619`. Only the GitHub remote carries the longer name.
  A session reconstructing an API path from the folder it is sitting in therefore writes
  `repos/Gawish-1997/phoenix-workforce/…`, and GitHub answers
  `{"message":"Not Found","status":"404"}` — the same body a genuinely missing deployment would
  produce. On 2026-08-29 that 404 came back for `…/commits/<sha>` on a commit that was
  simultaneously the tip of `origin/main`, and was first read as API propagation lag. On
  `…/deployments` the identical mistake reads as *the production deploy never happened*, which is
  the one question that command exists to answer. **Nothing committed here has ever carried the
  wrong name** — verified 2026-08-29 across every ref (`git log -S "Gawish-1997/phoenix-workforce"
  --all` returns no commits), across all six `repos/…` references (`AGENTS.md` §7,
  `docs/deployment.md`, `docs/disaster-recovery-runbook.md`, `docs/agents-incident-history.md`,
  and two in `.claude/skills/verify-context/SKILL.md`), and across all seven worktrees. The one
  `gh api` call in automation, `.github/workflows/deploy-cloud-run.yml:127`, interpolates
  `repos/${{ github.repository }}` and cannot be wrong. So this is never a defect to go fix in a
  file — it is a typo the checkout invites, and the fix is to read the name rather than infer it:
  `gh repo view --json nameWithOwner` returns `Gawish-1997/phoenix-people-workforce`, and
  `git remote -v` agrees.

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
- **Two more PostgREST filters that answer WRONG with no error** (relocated from `MEMORY.md`
  2026-08-28 together with their index line). **A `neq` against a jsonb key that is ABSENT matches
  ZERO rows** — `NULL <> 'true'` is NULL, not true — so an "exclude the flagged rows" filter
  silently drops every row that never carried the flag. Measured live on production 2026-08-23: the
  bare form returned **0 of 390** where the truth was **19 of 390**. Write the OR-form
  (`.or("<path>.is.null,<path>.neq.<value>")`) and prove it with a `Prefer: count=exact` call whose
  counts add up to the table total. And **an unbounded `.select()` stops at 1000 rows** — no error,
  no marker, the array simply ends, so "these are all the rows" is indistinguishable from "these are
  the first 1000". `scripts/recruitment-reread-never-read-cvs.ts` decided who counted as
  already-read from one such select over a table holding **912 rows, 88 from the cap** — and that
  script adds a row per candidate it reads, so it was walking itself into the cliff. Run
  `select count(*)` before trusting any unbounded select, then page with an explicit `.order()` plus
  `.range()`; without the order the page boundaries are undefined and a row can come back twice or
  never. `postgrest-neq-on-an-absent-jsonb-key-matches-nothing` ·
  `postgrest-unbounded-select-silently-stops-at-1000-rows`
- **`n_live_tup` is STALE in this production project — it reports LIVE tables as empty** (relocated
  from `MEMORY.md` 2026-08-28 together with its index line). Same family as the `list_migrations`
  rule above: query reality, never a ledger or a statistic. Measured 2026-08-13, with
  `pg_stat_database.stats_reset` NULL, so these are simply stale planner stats rather than a reset:
  `sales_records` read **0** against a real **11,267**, `field_workforce_compliance_days` **0**
  against **4,030**, `email_templates` **0** against **22**, `salary_records` 105 against **796**,
  `attendance_raw_punches` 292 against **4,039**. An audit trusting it would have declared
  `sales_records` and the whole Field Workforce Compliance module dead; both are live. The write
  counters (`n_tup_ins/upd/del`) are equally untrustworthy — they cover only activity since the last
  stats reset, and a PG major-version upgrade wipes them. Sweep all 309 tables with a real count in
  seconds via `query_to_xml(format('select count(*) as cnt from public.%I', table_name), …)`.
  `n-live-tup-is-stale-use-real-count`
- **A Supabase client request that times out at 15s STILL COMMITS.** `getSupabaseAdmin()` aborts after
  15s (`src/lib/supabase/server.ts`; raise it with `getSupabaseAdmin({ requestTimeoutMs })`), and the
  JS client throws "Supabase request timed out" — but Postgres keeps running and commits the
  statement. Every later step of a multi-call orchestration (rollup refresh, audit write) is skipped,
  so the result is a **silent half-applied state with no audit row**, not a clean failure. Hit in
  production 2026-08-09: Territory Sync re-stamped ~14k `source_of_sales_import_rows` (committed),
  the client timed out, and 55 batches' rollups were never refreshed — rows on the new geography, the
  drilldown on the old. Do a heavy multi-step mutation in ONE `plpgsql` function so a client abort
  rolls it all back. Three further DB-performance hooks sit in `MEMORY-ARCHIVE.md`, including the
  one this depends on: every DB round trip from here crosses the Atlantic.
  `supabase-client-15s-timeout-commits-anyway-half-applies`

- **A missing TABLE answers `PGRST205`, NOT `42P01`.** `42P01` is Postgres's own `undefined_table`,
  it is what a direct `psql` connection returns, and it is therefore what the guard gets written as
  and what looks right in review. PostgREST never sends it: a read against a table it cannot find is
  answered **out of its schema cache**, as `PGRST205 "Could not find the table 'public.<name>' in the
  schema cache"`, with no Postgres error code on the object at all. So `code === "42P01"` fires
  never, and the code reads as though it survives a window it does not survive.

  Measured 2026-08-30 while adding `ats_candidate_manager_folders` (PR #2762) against a database that
  did not yet have the table: the optional read threw, and a manager's **entire My Candidates page**
  rendered the portal error boundary. That page is not a folders page — one new table that had not
  landed yet took the whole screen down.

  The window is the normal case here, not an edge: **a Railway deploy applies no migrations**, so a
  merge to `main` serves the new code within minutes while the migration is still waiting to be run
  by hand. Every page reading a new table runs against a database without it for that whole gap.

  Treat "that table is not there" as a **set** rather than a code —
  `const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"])` behind one `isMissingTable(error)`
  helper, so a read path and a delete path cannot drift apart on it — and degrade to the empty answer
  rather than throwing: an empty shelf is survivable, a dead screen is not. Pin it in a registered
  test. Reaching the real failure needs a database that is missing a table, which no unit test can
  arrange, so source-pin the constant **and** assert that no bare `code === "42P01"` comparison has
  come back; `tests/manager-folder-shelf.test.ts` is the worked example.

  The sibling trap is sharper because it fails *silently* rather than 500ing: a missing **function**
  is `PGRST202`, and a detector matching on the words *schema cache* cannot tell it from a missing
  table — see `pgrst202-missing-function-reads-as-missing-schema`.
  `a-missing-table-answers-pgrst205-not-42p01`

**Database, grants and RLS** (relocated from `MEMORY.md`, 2026-08-28 — these are platform
mechanics, not Phoenix business rules, so under §2.2's cap they were spending index bytes for reach
this file already gives them)

- **A write REVOKE does NOT make a table read-only.** An `ON DELETE CASCADE` and a `SECURITY
  DEFINER` function both execute with the **table owner's** rights, not the caller's, so both ignore
  it. Both were live back doors around the `sales_records` freeze — 11,267 H1 rows, the only record
  of what H1 2026 was actually paid on: deleting an import batch cascaded through the front door,
  and `phx_reassign_replacement_ownership` could rewrite 880 rows / EGP 6,436,342.01. Measured on
  staging, not assumed — the identical update was `permission denied` directly and `SUCCEEDED,
  rows=1` through a definer function. **`has_table_privilege` reports the revoke faithfully and
  tells you nothing about either bypass**, so a grant listing cannot answer this. Run both sweeps
  before trusting any freeze: FK actions (`con.confdeltype in ('c','n','d')`) pointing into the
  protected table, and `pg_proc.prosecdef` functions whose body writes it. Fixed on prod 2026-08-14
  — `ON DELETE RESTRICT` plus the definer function no longer writing it; **do not redo or undo.**
  `a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function`
- **An append-only table needs a STATEMENT-level `BEFORE TRUNCATE` trigger.** Two independent
  reasons, and fixing one does not fix the other: `TRUNCATE` fires **no ROW triggers**, so a
  `FOR EACH ROW` guard never runs; and revoking `TRUNCATE` from `service_role` does nothing to the
  table **OWNER**, which is what migrations run as. Supabase's default ACL also grants `service_role`
  **ALL** on every new `public` table, so a bare `grant select, insert` restricts nothing — revoke
  `update, delete, truncate` explicitly, and from the **named** roles, never from `PUBLIC`. Whenever
  a table is called append-only, immutable, or an audit log, **prove all three verbs are refused
  against a real database**: neither defect is visible from source review, and neither would have
  failed a test written in advance. `append-only-tables-need-a-truncate-trigger`
- **RLS on with no `authenticated` grant is the NORM here — 222 of 308 public tables — not a defect
  class to sweep.** The posture is `service_role` only, stated outright in the default-privileges
  migration. The `expense_claims` 42501 incident makes "policy exists but no grant" look like a bug
  to hunt; that one was real for exactly one reason — `listExpenseClaims` reads with the **user's
  own session**. `getSupabaseRlsClientIfAvailable()` has exactly **three** importers (outstation
  claims-read, outstation expenses, payroll) and there is **no browser Supabase client anywhere in
  the repo**, so if the table is not read by one of those three the missing grant is correct, and
  granting is a pure widening that exposes real HR rows to every logged-in JWT to satisfy nothing.
  Two decoys: inert `TO authenticated` policies that never had a grant behind them, and executable
  `SECURITY INVOKER` functions with zero callers.
  `rls-policy-without-an-authenticated-grant-is-usually-correct`
- **ONE `auth.users` row with `banned_until = 'infinity'` 500s the ENTIRE GoTrue admin API.** GoTrue
  scans it into a Go `time.Time`, which cannot hold a non-finite `timestamptz`, so any page whose
  result set includes that row returns `500 "Database error finding users"` in ~90ms — it reads like
  a code error, not a timeout. **The failure is page-shaped, so a small `per_page` probe passes and
  it looks transient. It is deterministic.** While it existed, Studio's Auth users list, the orphan
  check, and every account create/repair needing stale-link recovery hard-failed. Retire an auth
  account with the app's own finite `876000h`, **never `'infinity'`**; the app never writes that
  value, so finding one always means a direct DB/Studio write. One query finds it:
  `select email, banned_until from auth.users where not isfinite(banned_until)`. Repaired on prod
  2026-08-19. `banned-until-infinity-breaks-the-whole-auth-admin-api`

**Probing, attributing and reporting production**

- **A 200 from a health endpoint can be blind to the thing that is broken.** OpenAI's `/v1/models`
  returns 200 for a key with no BALANCE, so it certifies an account that cannot complete a single
  request — probe an actual completion instead. No AI failure is logged here, so the product
  degrades silently to the rules path. The BILL cannot be read from the API at all: costs 403s and
  usage returns 200-but-EMPTY, so reconstruct spend by counting `ats_candidate_cv_extractions`.
  (That memory file's NAME is stale — the key WORKS.)
  `openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules` ·
  `openai-spend-cannot-be-read-from-the-api-reconstruct-it`
- **`app_error_events` returning 0 rows means QUIET, not broken.** It is fed by real users' browsers
  and arrives in BURSTS (7 rows in 46s), so an empty table is an ordinary state and not evidence of
  a dead route. Prove the route with **405 against a 404 control**, and **never POST a synthetic
  error to production** to check that it works.
  `app-error-events-is-user-triggered-zero-is-not-broken`
- **The Error Monitor HIDES rows whose `environment` is NULL**, so the screen reads clean while the
  table holds the incident. And a `create table zz_backup_… as select` copies rows but never the
  source table's RLS or its policies — so **measure the new table's ACL; never assume it either
  way.** Six such tables did publish 529 rows to `anon` on 2026-08-09, which is where the flat
  "they are anon-readable" reading came from; but re-measured **2026-08-28** this project's
  defaults no longer grant `anon`/`authenticated` at all, and all **8** surviving `zz_backup_*`
  tables in production carry an owner+`service_role`-only ACL with **0** granting `anon` and **0**
  granting `authenticated`. Both stale readings cost something: "still exposed" is a false alarm,
  "safe by default" is a leak. So measure — `select relacl, relrowsecurity from pg_class` on the
  table you just created, then `get_advisors(type: "security")` after any bulk repair.
  `error-monitor-hides-null-environment-rows` · `ad-hoc-backup-tables-are-anon-readable`
- **`updated_by_hr_id` LIES about who wrote a row.** Never attribute a production write from it.
  `how-to-attribute-a-production-write`
- **HR ids are MIXED CASE in the database, so a plain `.eq` silently under-returns.**
  `activity_events.hr_id` is mixed case, the direct-order tables carry BOTH cases, and `access.hrId`
  is lowercase — one `.eq` hid **28% of reps' own orders**, which reads as a real business finding
  rather than a query bug. `activity-events-hr-id-is-mixed-case-not-lowercase` ·
  `direct-order-hr-id-columns-are-mixed-case-and-access-hrid-is-lowercase`
  **And the loss is not always partial — on `au.occupancy_history.occupant_canonical_hr_id` it is
  total.** That column is entirely lowercase while `employees.hr_id` is not, so the two never meet.
  Measured on production 2026-08-29: **120** occupancy rows, **0** carrying an uppercase character,
  against **178 of 179** employee hr_ids that do — `join employees on hr_id = occupant_canonical_hr_id`
  returns **0 rows**, and `on lower(hr_id) = occupant_canonical_hr_id` returns all **120**. A partial
  loss at least looks odd; a total one does not look like a join failure at all, because an occupancy
  row that matches nobody reads as **a vacant seat** — a plausible org-structure fact that nobody
  re-checks, on the very model AGENTS §4 calls the source of truth for vacancy data. Lower BOTH sides
  of any hr_id comparison. **The occupancy half has no memory file of its own** — the two slugs above
  cover the mixed-case rule, and this account is the record for the total-loss case. #2617 also cited
  `a-mock-name-generator-reproduces-real-employee-names` here, for the same wrong reason as the
  `execute_sql` trap above; do not re-add it.
- **The Sato logo's wordmark is WHITE, so "SATO" vanishes on white paper.** Reverse it onto a navy
  band, or recolour the near-white pixels, before any export or print.
  `sato-logo-wordmark-is-white-invisible-on-paper`

**Validation**

- **A repo-wide pattern sweep must grep the TESTS for the old string too — a pinning test can pin
  the ANTI-pattern.** `tests/contract-renewal-hardening.test.ts` asserted the exact source line
  `if (!secret) return !isProductionRuntime();` across FOUR routes, so #2479 — whose entire purpose
  was deleting that line from 18 routes — turned the required `validate` job red on its own head.
  Two traps compound. First, the test enforces the very hole being closed, so "the suite went red"
  reads as "your fix is wrong" rather than "the pin is stale." Second, `runTest` **rethrows**
  (`tests/run-tests.ts:991-1002`), so a `for` loop over N routes reports only the FIRST: CI printed
  `birthdaysRoute` and stopped, hiding three identical failures **and every test after it**, so a
  green run was never demonstrated for anything downstream. Before any sweep, run
  `git grep -l '<the exact old line>' -- tests`, and fix the pin in the same commit.
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
- **A test can NEVER hand a function a `process.env` literal — take the VALUE, not the bag.** Next
  augments `NodeJS.ProcessEnv` with a required `NODE_ENV` (`node_modules/next/types/global.d.ts:21`),
  so nothing in this repo causes it and grepping `src/` for the reason finds nothing. Both spellings
  fail, and each error only surfaces once you have fixed the other: `env: NodeJS.ProcessEnv =
  process.env` gives **TS2345** at every call site passing a literal, and `env: { MY_VAR?: string } =
  process.env` gives **TS2559** at the default (an all-optional weak type shares no property with
  `ProcessEnv`, whose only named member is `NODE_ENV`). An existing `env: NodeJS.ProcessEnv`
  parameter that compiles today only does so because nothing passes it a literal — that precedent
  does not transfer. Default the individual value at the signature instead
  (`configuredPath: string = process.env.MY_VAR ?? ""` — `resolveChromiumPath`, #2432), or take a
  `Record<string, string | undefined>` and use bracket access, as `src/lib/env.ts:6` does. Each
  attempt otherwise costs a full red CI round, and the local suite cannot see it at all.
  `a-test-can-never-hand-a-function-a-process-env-literal`
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
- **A narrowed SELECT disarms every gate downstream of it.** A gate cannot fire on a column the
  query no longer fetches, so the branch still *reads* correct while the check is dead. Test the
  SELECT, not the branch. `a-narrowed-select-disarms-every-gate-downstream-of-it`
- **An OPTIONAL field written UNCONDITIONALLY is a silent erase.** With `.update()` OMIT the column
  entirely; with `.upsert()` carry a before-image. Both real occurrences are fixed (#2326, #2329) —
  the PATTERN is what regenerates, not those two call sites.
  `optional-field-written-unconditionally-is-a-silent-erase`
- **A feature can ship green, deploy cleanly, and be reachable by NOBODY - and zero usage is what
  both look like.** #2237's Capture Evidence was rejected for every `doctor` customer (**59 of the
  65 customers it existed for**, and 115 of the 126 pending links behind them) because one
  hand-written copy of the type list omitted `doctor`, while the union, the DB constraint and the
  classifier all allowed it - the module minted rows it then refused to accept back. Nothing
  errored, CI was green, the deploy was healthy, and the ONLY symptom was zero evidence files
  captured since it went live, which reads exactly like slow adoption. **When a just-shipped
  feature shows zero usage, exercise the path end to end before concluding it is adoption** - a
  silent 100%-rejection rate and nobody-tried-it are indistinguishable from outside. Fixed by
  #2249, which also deleted the copy: check a shared list, never a local duplicate of one.
  `capture-evidence-was-dead-on-arrival-for-doctor-customers`
- **A merged fix on a path nobody has exercised is untested, not proven.** #2241 gave the three
  payroll batch mutations audit rows; verified 2026-08-28, production `audit_logs` still holds
  exactly **15 `payroll_batch` rows, newest 2026-07-13, 0 since the fix** - no batch has been
  imported, replaced or deleted since, so the new path has never written anything. The row count
  cannot tell "works" from "broken" until someone touches a batch.
  `payroll-mutations-were-unaudited-until-2026-08-21`

- **`cn()` SILENTLY DROPPED every `text-phx-*` size, and nothing in this repo can see it.**
  tailwind-merge never sees Tailwind v4's CSS-first theme, so it classifies a custom-named font size
  as a COLOUR — and any real colour class in the same `cn()` call then wins and removes it. The
  sidebar rendered at **16px instead of 13px** and badges at **16px/900 instead of 10px**, across
  roughly **4,800** call sites. It is invisible in source review, in lint, in typecheck and in a diff
  audit; only `getComputedStyle` in a real browser sees it. The literal `text-[13px]` form was always
  SAFE — **the rename to a named size is what created the bug**, so a well-meant "tidy up the class
  names" pass is precisely the change that reintroduces it.
  `tailwind-merge-strips-custom-named-font-sizes`
- **`@/lib/utils` resolves to the ROOT `lib/utils.ts`, NOT `src/lib/utils.ts`.** `tsconfig.json` maps
  `"@/*": ["./*", "./src/*"]` — the repo root is tried FIRST — and both files really exist (measured
  2026-08-29: `lib/utils.ts` 2,993 bytes, `src/lib/utils.ts` 1,022 bytes). So editing
  `src/lib/<x>.ts` and reloading changes NOTHING, with no error anywhere to explain why; the symptom
  is a correct-looking edit that simply has no effect, which reads as a caching problem rather than a
  resolution one. Before touching any `src/lib/<x>.ts` whose importers say `@/lib/<x>`, run
  `ls <x>.ts` at the repo root first. `at-slash-lib-shadows-src-lib-via-tsconfig-paths`

**Memory and this index**

- **Sweep memories by CLAIM, never by filename or topic.** Every staleness sweep here has been scoped
  by topic, and that is exactly why they keep missing what matters: the 2026-08-19 sweep correctly
  banner-stamped the files that are *about* deployment, while "ships on the 2-hourly prod deploy cron,
  NOT on merge" and a dead Supabase ref survived untouched inside memories about an excuse module, a
  CRM filter and a sales import. A topic sweep fixes the files a session reads when it is already
  being careful, and misses the ones it reads when it is not. Grep the assertion itself across every
  file, then triage each hit: a present-tense assertion gets corrected in place (the dangerous
  bucket), an outstanding action pointing at dead infrastructure gets retired, and a dated record of
  what was true then gets left alone — **never rewrite a dated record.**
  `staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones`

**Parallel sessions** (relocated from `MEMORY.md`, 2026-08-27 — these are agent-operating traps, not
Phoenix business rules, and the index line at its cliff is the wrong place for them)

- **A parallel session can collide with NO git trace at all.** Six instances now. The first few were
  two sessions independently chasing one incident, and the prescribed checks caught those: `gh pr
  list`, `git log origin/main --oneline -20`, `git worktree list`. **On 2026-08-27 all three returned
  clean while another session was actively editing the same file** — it never opened a PR, never
  committed, and worked **in the primary checkout** rather than a worktree. The only signal was the
  SessionStart hook's working-tree line (`0 staged, 1 modified, 0 untracked / Changed: M AGENTS.md`).
  **Read that line as a collision signal, not as noise**: a file modified in the shared primary that
  you did not modify is someone else's live work. **And a stale lock proves the named PID is dead,
  not that the folder is unattended** — a live session appeared in none of the startup signals that
  same day; what surfaced it was a `.claude/worktrees/` branch that had not existed minutes earlier,
  a sibling worktree's HEAD advancing across checks, and untracked `tests/_tmp-*` probes appearing in
  the primary. Re-run `git for-each-ref refs/heads` and `git worktree list` at intervals through a
  long session. Never delete another session's `_tmp-*` probes or its `.claude/worktrees/` tree.
  **Resolve a collision by MERGING, never by discarding** their working copy. And note the fifth
  instance was self-inflicted: **if you report a finding to another session, it is theirs — do not
  also fix it**; reviewing and patching the same defect in parallel is a manufactured conflict, and a
  conflicted PR runs no CI at all here. `feedback-parallel-session-pr-collision`
- **ONE approval can reach SEVERAL sessions — N sessions holding the same "yes" is N executions.**
  2026-08-27: the owner typed `merge 2480` and it landed in **3** live sessions (`CONTTINUE` reached
  5); one of them merged and shipped to production while this session still read
  `validate: IN_PROGRESS`. He then said "i didnt merge it", which was true from the window he was
  sitting in. A second `gh pr merge` is harmless, but a bulk email, a destructive SQL statement or a
  production migration run three times is not. **Before executing a protected action on a terse
  approval** ("merge 2480", "yes", "go", "do it"), check how many sessions are live, say so in the
  reply, and re-verify the target's live state immediately before acting — not merely before
  reporting. **If it is already done, report who did it and never retry.** **`mergedBy` naming the
  owner is NOT evidence of a human click** — every session authenticates as his account, so the API
  cannot tell a UI merge from a session's command; grep the transcripts, which carry per-call
  timestamps and the verbatim command. A peer session's own summary is an inference and has been
  wrong. `one-approval-can-reach-more-than-one-session`

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
  an OLD `CreationTime` proves it never went. **Run that `rmdir` from PowerShell, not the Bash
  tool** — `cmd /c rmdir /s /q "$folder"` with an MSYS-mangled backslash path prints the cmd banner
  and does NOTHING, and that stale `CreationTime` is the only thing that reveals it (2026-08-28).
  `repo-doctor-strip-idle-cannot-run-with-sessions-open` ·
  `repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm`
- **repo-doctor's RETIRABLE verdict names the branch a folder HAD at scan time** — a parallel session
  can repoint the tree first, and the report prints a paste-ready `git worktree remove` beside it, so
  `--force` eats the new branch's work. Re-read `status -sb -uall` and `git log origin/main..HEAD` in
  the worktree at the moment of removal, never the report: on 2026-08-23 one listed retirable on merged
  #2362 sat on a NEW branch with 90 uncommitted lines and an unpushed migration, and opened #2364.
- **Every retirement gate in this list can PASS on a worktree that is in active use.** The bullet
  above catches a repointed BRANCH; nothing catches a live PROCESS. On 2026-08-28
  `_wt-reps-plans-line-region` passed all four at 09:07:5x — branch matched on a live re-read,
  `status --porcelain -uall` empty, `gh pr list --state merged` returned #2494, and the
  cumulative-diff patch-id equalled the squash commit's exactly (`ec45aa3b…`) — while a Next build
  was writing `.next/client-development-fallback/*.pack.gz_` into it at **09:08:05**, seconds later.
  A session was mid-diagnosis on that very page (the `unstable_cache` Map entry below, same PR).
  `git worktree remove` then died `Permission denied`, which **still deregistered the tree**: source
  files deleted, `.git` entry gone, a husk left. Two cheap signals see what the gates cannot —
  **the newest mtime under `.next/`** (`Get-ChildItem -Recurse -Force <wt>\.next | Sort-Object
  LastWriteTime -Descending | Select-Object -First 1`), and **HEAD moving between the gate read and
  the removal**. That tree's HEAD went `1325649a` -> `99349cf0` inside one minute, which also
  silently poisoned the rescue ref: `git branch rescue/<name> $(git rev-parse HEAD)` taken at
  removal time captured **`main`'s squash commit, not the tip**. Read the tip at the GATE and reuse
  that SHA, then verify the ref points where you meant. Nothing was lost here only because the
  content was already upstream. **Worktree->branch bindings churn far faster than they look**:
  measured the same morning, **five of the nine** trees standing 30 minutes earlier had been
  repointed — the PRIMARY among them, off detached HEAD onto a branch — two new trees had appeared,
  and the session count reached 11. Treat any scan older than the current command as fiction.
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
- **`next dev` CANNOT run in a worktree — the junction §5 prescribes is what breaks it.** Turbopack's
  resolver reads the Windows directory junction as a symlink escaping the project root and fatals on
  the first route: `Symlink [project]/node_modules is invalid, it points out of the filesystem root`.
  Reproduced twice on 2026-08-28, with and without `--turbopack` — Next 16.2.11 prints "(Turbopack)"
  either way, so the CLI flag alone gives you no webpack fallback. The primary checkout, same repo and
  same version, is fine: its `node_modules` is a real directory. §5's junction pattern was written and
  tested for `typecheck`/`lint`/`node scripts/…`, none of which go through Turbopack's root
  resolution. **Do not burn more than one retry on it** — verify against the primary checkout's server,
  or prove the change at data level instead. `turbopack-cannot-resolve-a-junctioned-node-modules-here`

**Next.js runtime**

- **A >2MB `unstable_cache` entry KILLS the dev server** — it throws only in dev, is uncatchable, and is
  muted in prod. Gzip rows; return null over the ceiling.
  `next-2mb-data-cache-throws-only-in-dev-and-kills-the-server`
- **`unstable_cache` SERIALIZES, so a returned `Map` comes back `{}`** — and the page works on exactly
  one render, the one that fills the cache, then throws on every render after it for the whole
  revalidate window. Measured 2026-08-28 on `/admin/reps-plans` (#2494): first load the full board,
  every load after `TypeError: index.get is not a function`, rendered as the admin error boundary — a
  page that reads as a **permission redirect**, not a crash, which is where the first 30 minutes of
  diagnosis went. Cache the ROWS and rebuild the object graph per call. **No unit test can see this**:
  every test calls the pure builder, where a Map is still a Map, and it is only reachable by loading
  the page TWICE. Pin it two ways — assert a JSON round-trip loses `.get`, and source-pin the loader
  as a plain `async function`. `unstable-cache-serializes-a-map-into-an-empty-object`
- **Standalone tracing copies FILES, not pnpm SYMLINKS** (fixed 2026-08-22 with a hoist plus a `*/**`
  glob, now CI-gated), and **a top-level `import sharp` 500s a whole PAGE** when the `.so` is missing.
  Load native modules on demand and assert at BUILD. `next-tracing-copies-files-not-pnpm-symlinks` ·
  `next-standalone-trace-misses-a-native-librarys-so-dependency`

**Browser and dev-auth**

- **A MINIMIZED window makes every browser reading LIE — check `document.visibilityState` FIRST.**
  When Chrome is minimized or occluded the tab reads `hidden`, and Chrome throttles `setTimeout` to
  ~**1 per second** and stops `requestAnimationFrame` **entirely** (measured **0** frames, not slow
  ones) and stops compositing, so `Page.captureScreenshot` times out. **Both** browser surfaces here
  report `hidden` — the claude-in-chrome tab and the Claude Browser pane. On 2026-08-28 that produced
  four false diagnoses on one page in one session: "998ms per mouse move" (the timer throttle — the
  same drag ran in **5 ms** through a `MessageChannel` yield), "the drag freezes the browser"
  (nothing froze; `Runtime.evaluate` answered instantly throughout), "it reproduces on production so
  it predates the branch" (same artifact), and "the page never hydrates" (real reading, wrong cause —
  one screenshot forced a frame and it hydrated). **dnd-kit cannot run at all** when hidden: it
  measures droppables inside rAF, so every drop is a no-op. **Plain `.click()` and `MessageChannel`
  yields still work**, so click-driven UI IS verifiable and drag-driven UI is NOT — a standing reason
  to give any drag a click equivalent. Two companions: `javascript_tool` does **not await a returned
  promise** (stash to `localStorage` and read in a second call — **not** to an attribute of `<html>`,
  which React reverts), and the extension's **isolated world** cannot see the React fiber expandos,
  so every fiber-based hydration probe returns 0 regardless of truth — judge hydration by behaviour.
  `a-minimized-window-makes-every-browser-test-lie`
- **Click by TEXT — blind coordinate clicks once fired a real production collection run.**
  `blind-coordinate-clicks-fired-a-production-collection-run`
- **Dev login is `GET /api/dev-auth?role=<Role>`, and it DOES role-switch the Browser pane.** This
  line said the opposite until 2026-08-29 — "it is header-only and the Browser pane cannot use it" —
  and that sentence is true only of the SEPARATE `x-phoenix-role` / `x-phoenix-hr-id` request-header
  path (`isLocalDevHeaderRequest`, gated on `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`), which the pane
  genuinely cannot set. The cookie route is a different mechanism: `app/api/dev-auth/route.ts` sets an
  httpOnly `phoenix_dev_preview` cookie and 302s to the role's landing page, and
  `accessContextFromDevPreviewToken` is consulted BEFORE the header path — so no proxy is needed. Measured in the pane on 2026-08-29 by navigating to the URL three times:

  | Navigated to | Landed on | `/admin` links | `/employee-portals` links |
  | --- | --- | --- | --- |
  | `?role=Super Admin` | `/admin` | present | — |
  | `?role=Medical Rep` | `/employee-portals` | 0 | 69 |
  | `?role=Super Admin` | `/admin` | 79 | 0 |

  So it is a genuine round-trip switch, not merely a first login. The memory file had carried this
  correction since 2026-08-09 and re-stated it on 2026-08-28; what stayed wrong was its frontmatter
  `description` and both auto-loaded copies — which is the failure mode AGENTS.md 2.2 warns about,
  since the description is what decides whether a memory is recalled at all. It also closes the one
  question that file left explicitly open: a 2026-08-28 attempt left the pane on `/` reading
  "Loading workspace" and was recorded as proving nothing either way. It proves nothing because that
  string is a known false signal — `document.body.textContent` read 166,998 chars of real admin
  content on exactly such a page here. **Role SWEEPS still use the headers**, for the reason stated
  further up this file: each cookie switch replaces the browser's session, so sweeping N roles
  through the cookie clobbers it N times. The slug below is now a misnomer; the file it names leads
  with the correction.
  **CORRECTED 2026-08-30 — it DOES take `hrId`, and `loginId` too.** The paragraph above said the
  cookie route needs neither, and that was measured wrong. `app/api/dev-auth/route.ts` reads both
  from the query string and bakes them into the session token, so
  `?role=National%20Sales%20Manager&hrId=a-12&next=<path>` signs you in as THAT PERSON, not merely as
  that role. It matters because without it there is no way to verify anything scoped to one manager's
  own team in a browser — a role alone lands you on the right page as nobody in particular. Header-only
  is the separate `x-phoenix-*` path, which the pane cannot set.

  **A HIDDEN pane also mixes correct rects with 0×0 ones** inside one measuring sweep, so a layout
  reading taken while it is hidden is part real and part garbage. Re-measure with the pane visible;
  do NOT retract the number — the 125px read was REAL and the repo MODEL of it was wrong (#2353).
  `dev-auth-is-header-only-browser-pane-cannot-use-it`

- **Turbopack 500s with `0xc0000142` when the commit charge is exhausted** — close a session, do not
  debug the code. `turbopack-500s-with-0xc0000142-when-commit-is-full`
- **Verify a 375px mobile layout with NO dev server.** `verify-a-mobile-layout-without-a-dev-server`

**Machine ceiling** (the same exhaustion the two entries above are symptoms of)

- **The ceiling is the Windows COMMIT limit, not RAM — and a freeze leaves NO dump.** Commit is
  RAM + pagefile, so the pagefile is the half that was fixable. It was raised to a fixed 16 GB on
  2026-08-25 (limit ~19.79 GB -> 31.79 GB), then **re-pinned on 2026-08-26 to 32768/65536 MB — a
  RANGE, not a size, so the limit is `RAM + the pagefile as currently ALLOCATED` and it FLOATS**:
  15.79 + 32.00 = **47.79 GB at rest**, climbing toward **~79.79 GB** as Windows grows the file
  under pressure. That growth, not a third reset, is the 53.83 GB limit in the next entry — a
  pagefile grown to ~38 GB. **Read the limit, never quote it from here**: a HIGHER reading is
  ordinary growth, but a reading BELOW 47.79 GB — ~37.4 GB, say — means the setting was reset
  again, which has now happened twice. `Win32_PageFileUsage.AllocatedBaseSize` tells the two apart.
  **A pagefile change does not fix a leak** — Windows was reinstalled 2026-08-26 06:19 and
  the box still froze at 10:57 and 15:15 on the raised limit. A commit-limit hang produces no
  bugcheck and no minidump, so an empty `C:\Windows\Minidump` is the **expected** signature and never
  an all-clear — the tell is `dwm.exe` dying with `0xC00001AD` (`STATUS_COMMITMENT_LIMIT`) minutes
  before the freeze, with `System.OutOfMemoryException` in the Application log. **Never judge a
  process by `VirtualSize`** — it is address-space *reservation*: on this box Edge reserves 3,621 GB
  against 503 MB of real commit. That trap is how an ordinary `node` was read as a 22 GB runaway and
  `repo-doctor.mjs` was wrongly blamed for three freezes on 2026-08-25 — an accusation raised and
  then withdrawn. Judge by commit, and suspect **breadth** (many sessions plus Excel/Edge/Defender)
  over any single process. Symptoms of a saturated commit charge — none of which mean your work was
  wrong: bash `fork: retry: Resource temporarily unavailable` / `0xC000012D`, PowerShell refusing to
  load `System.Management.Automation` with *"The paging file is too small"*, `gh` returning
  *"Resource temporarily unavailable"*, and a heredoc silently failing to create its script so the
  next command dies `MODULE_NOT_FOUND`. Check the shell with `echo alive` before blaming the task.
  `commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb`
- **Two decoys sit on top of that diagnosis.** `nvlddmkm` (the display driver) in the event log is a
  **DECOY** — it is what dies when the desktop compositor is starved, not the cause. And the
  `node.exe` gigabyte figures in **Event 2004** are the one memory number here that IS real, unlike
  `VirtualSize`: do not dismiss them as reservation. **The single largest leak found so far is a
  throwaway ExcelJS probe** — a `tests/_tmp-run-*.mjs` scratch script took commit 22 -> 41 GB in 40
  seconds, reaching 99.7% of a 53.83 GB limit. ExcelJS holds workbook data **off-heap**, so
  `--max-old-space-size` cannot cap it. Delete such probes when done; one sat untracked in the tree
  for days. `commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb`
- **An interrupted session leaves the tree BROKEN ON PURPOSE.** Before acting on a bare "commit it"
  from a resumed or compacted session, `git grep BREAK-` — a deliberate breakage marker means a
  regression test is mid-proof, and the source-pinning test states the intended fix verbatim.
  Committing over it ships the break and destroys the proof.
  `an-interrupted-session-leaves-the-tree-deliberately-broken`


## A docs-only PR's `validate` never runs the tests

**Measured 2026-09-01, after three PRs shipped `main` red without a single red PR check.**

`ci.yml` detects a documentation-only change and skips the expensive STEPS while still reporting
every required check name — so a docs PR costs seconds instead of four minutes. That part works as
designed. What is easy to miss is that **the fast path is `pull_request`-only**:

| event | detector answers | what runs |
| --- | --- | --- |
| `pull_request`, docs-only | `docs_only=true (documentation only)` | nothing expensive — `validate` passes in ~10s |
| push to `main` | `docs_only=false (not a pull_request — always run everything)` | the full suite |

Both lines above are quoted from the real job logs of #2868 and its merge commit `9c161d35f`.

So for a docs-only change the test suite's **first ever run is the push to `main`** — the branch
that deploys to production. A green PR there is not weak evidence, it is **no evidence**: the tests
were never executed. #2862, #2864 and #2866 each showed `validate pass` in about ten seconds, and
`main` was red from #2864 onward because the relocation dropped `AGENTS.md` below a slug floor
pinned in `tests/memory-index-reachability.test.ts`. Nobody noticed for three merges.

**The tell is the duration.** A `validate` that finishes in ~10s ran no tests; one that takes
minutes did. When a docs-only PR goes green, the check that matters is the run on `main`'s NEW head
after merging — which AGENTS.md already told us to do, and which the ten-second green makes very
easy to skip.

Fail-closed is deliberate on both sides: the detector answers `false` if it cannot resolve the file
list, and refuses to assume docs-only. Do not "fix" the asymmetry by extending the fast path to
pushes — that would remove the only run that catches this class of failure at all.
## `node --test` on a test file in this repo proves nothing

Measured 2026-09-01. Every suite here is an **exported function** — `tests/memory-index-reachability.test.ts`
is one `export function runMemoryIndexReachabilityTests()` spanning lines 50-266 — and `tests/run-tests.ts`
imports it and passes it to `runTest(name, fn)`. The file itself never calls `test()`.

Node's runner does not treat that as an empty file. It treats the FILE as the test, and a file that imports
cleanly is a file that passed:

```
node --experimental-strip-types --test tests/memory-index-reachability.test.ts
OK testsmemory-index-reachability.test.ts (137ms)
  tests 1 | pass 1 | fail 0
```

That run asserts NOTHING. It was produced twice on this repo while quoting it as verification, and the second
time the file under test had been **deliberately broken** — a load-bearing slug stripped out of `AGENTS.md`,
exactly the condition the suite exists to catch. Still `pass 1`. The failure mode is the dangerous direction:
it never goes red, so it reads as a clean verification rather than as a broken harness.

This matters most on a **docs-only PR**, where `validate` fast-paths and runs no tests at all (see the
docs-only section above). A session reaching for a local run precisely because CI will not do one is the
session most likely to get the vacuous green.

The real invocation imports the module and calls the export:

```
node --experimental-strip-types --input-type=module -e "
  const m = await import('file:///F:/Phoenix%20Workforce/phoenix-workforce/tests/<name>.test.ts');
  await m.run<Name>Tests();
"
```

And per AGENTS.md 2.1, a local green only counts once the same command has been shown to go RED on the
suite's own headline assertion. Breaking it produced the right one:

> every memory the map marks load-bearing must still be named in AGENTS.md

## Relocated from AGENTS.md — 2026-09-01

Verbatim, unabridged. These entries had grown from cues into full accounts inside `AGENTS.md`,
which auto-loads in full on every request. Per AGENTS.md §2.2 the cue — and every memory slug —
stays in `AGENTS.md`; the account lives here.

- **`next dev` in a worktree needs the explicit `--webpack` flag** — TURBOPACK is what rejects the §5 junction, not Next. Measured 2026-08-29: `--webpack` served a junctioned worktree fine (`Ready in 1770ms`, HMR and all). With and without `--turbopack` are NOT the same as `--webpack`, and this line said "CANNOT run" off exactly that gap. `turbopack-cannot-resolve-a-junctioned-node-modules-here` **`pnpm run dev` now CHOOSES for you** (`scripts/dev-server.mjs`: webpack on win32, turbopack elsewhere) — the platform guard has been deleted three times, most recently by #1435, so the measurements live in that file. **CORRECTED 2026-09-01 — the watchdog's 6 GB kills are NOT a turbopack trait, and this line said they were.** **SEVEN** webpack servers were killed at the same ceiling in the 38 minutes AFTER that launcher merged (02:19–02:46 Cairo, 6.03–7.23 GB, one started by the launcher itself WITH a memory cap set) — indistinguishable from the eight before it; 100 attempts / 98 succeeded all-time. So **the bundler is never the fix for the kill/restart sawtooth**. **You cannot attribute a kill to a bundler from `mem-watchdog.log`**: both spawn the same `start-server.js` child, so grepping the logged cmd for `turbopack` returns 0 of 100 and reads as *no turbopack kill ever happened* — attribute by TIMESTAMP, and count with `-CaseSensitive` or `KILL` also matches every `killed OK`. Turbopack's OWN failures are WEDGING (no answer to `GET /` in 25-60s) and the junction above. The sawtooth is a **watchdog-THRESHOLD** problem — this dev server legitimately reaches ~6 GB — made acute by running **two** servers at once (§5: one, ever); each cycle re-drove RAM to 94% and re-evicted the desktop to the pagefile. **`--max-old-space-size` cannot help**: measured no-op, `heap_size_limit` 4288 MB with AND without it, because the growth is off-heap.

- **The SUITE runs with PRODUCTION credentials while a test sets `APP_ENV=production`.** So
  `isProductionRuntime()` is TRUE for part of every run, and any module that writes on it writes to
  PROD from a bare `pnpm run test`. Gate such a write on `PHOENIX_TEST_SUITE` — set in
  `tests/run-tests.ts`, read nowhere else. `NODE_ENV` alone is not enough: it depends on two other
  tests' restore discipline, and it is READ-ONLY in the type system, so assign it through a mutable
  view. `the-test-suite-runs-with-production-credentials-and-app-env-production`

- **Arabic + English in ONE value needs direction PER LINE, and `dir="auto"` on the block is the
  WRONG fix.** Nothing in this repo can see either state, and both shipped through four green
  checks. `auto` reads only the FIRST strong character, so a bilingual body turns wholly RTL and the
  ENGLISH half then renders backwards (`Thanks for contacting Sato Pharma.` becomes
  `.Thanks for contacting Sato Pharma`) — the exact mirror of the bug being fixed.

  **SINGLE-language free text is the opposite case.** Block-level `dir="auto"` is correct there and
  is already house style across 57 files. Do not "fix" those.

  **Measure production for Arabic before changing a screen.**
  `outstation_expense_requests.notes` carried Arabic in 17 of 48 rows; `coaching_reports` in **0 of
  112**. A screen with no bilingual data does not have this bug.
  `bilingual-bodies-need-direction-per-line-not-per-block`
