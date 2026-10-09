# Why everything felt slow — the 2026-10-08 measurement

The account behind `scripts/slow-audit.mjs` and `tests/slow-audit.test.ts`. Run the audit rather
than reading this file for current numbers:

```bash
node scripts/slow-audit.mjs
```

`--quick` skips the hook and CI probes (machine layer only, ~10s). `--json` is machine-readable.
`--history` prints every past run. `--transcripts [--since YYYY-MM-DD] [--until YYYY-MM-DD]` reads
what the sessions actually waited for, from their own transcripts (Layer 6, below; Cairo days,
`--until` exclusive, its own log `~/.claude/logs/slow-audit-transcripts.jsonl`). Every run appends one record to
`~/.claude/logs/slow-audit.jsonl` and prints the delta against the previous one, because **a single
reading proves nothing** — it attributes itself to whatever happened to be open at the time. A
slowness claim needs a before and an after.

## What was asked

On 2026-10-08 the owner said working in the Claude desktop app had become unacceptable —
*"everything takes hilarious time"* — and that he could not tell whether the cause was settings,
the repo, CI, or something else. Four layers were suspected at once. Two earlier sessions had
answered by blaming the repo and the CI pipeline.

## The answer: one layer, and it was none of the suspected ones

| Layer | Measured 2026-10-08 01:10–01:15 Cairo | Verdict |
| --- | --- | --- |
| **Machine memory** | **9,447 hard page faults/sec** (peak 38,885), **730 MB free of 16,174** | **The cause** |
| Claude app | 31 processes, 5,034 MB resident; one process at 45→103% of a core, 1,414 MB, 16.3h up | Second, and it feeds the first |
| Transcripts | 5,523 MB total, 3,648 MB in this project across 452 files; 47/43/29 MB files open | What the app process is holding |
| Sessions | 8 engines alive, rising to 9 during the audit | The multiplier on everything above |
| CPU | 47–78% total | Not CPU-bound |
| Disk | 91–95% idle | **Not a disk problem — and see below** |
| Hooks | 686ms → 1,552ms per Bash call as RAM fell | Real, but a *victim*, not a cause |
| CI, pull request | 197s wait, ~6 billed minutes | Healthy |
| CI, push to main | 314s wait, ~12 billed minutes | Healthy; `Build` (246s) is the floor |
| Firebase | **no dependency at all** in the web app | Buys the web app nothing |

9,447 hard faults a second is thrashing. Every fault is a stall on disk for a page that should have
been resident, which is why file reads, hook spawns, keystrokes and UI repaint were all slow **at
the same time** — a symptom shape no repo-side cause can produce. A slow test suite cannot make
typing slow.

## 🔴 The disk being 95% idle is not evidence against paging

This repo's own machine-ceiling notes record, from 2026-09-17: *"disk sat 99.6–99.9% idle with a
0.00 queue while the box was slow"*, and conclude that the disk was therefore not involved. The
first half is a correct observation; **the inference that paging was not involved does not
follow.** An NVMe serves ~9,400 random 4K faults a second at a queue depth near zero, so it reports
idle while every one of those faults still costs the faulting thread its timeslice.

`Memory\Pages Input/sec` is the test. Disk utilization and queue length cannot see it. That is why
the audit reads the fault rate first, reads the disk figure only so the report can say out loud
that it proves nothing, and why `tests/slow-audit.test.ts` fails if the disk figure ever appears
inside `verdict()`.

## The hook figure is a thermometer, not a cause

Measured twice, ten minutes apart, with no settings changed in between:

| | 01:00 | 01:10 | change |
| --- | --- | --- | --- |
| free RAM | 958 MB | 730 MB | −228 MB |
| hard faults/sec | — | 5,257 | — |
| one bare `node` spawn | 65ms | 138ms | **+112%** |
| **hooks per Bash call** | **686ms** | **1,008ms** | **+47%** |
| hooks per Edit call | 777ms | 835ms | +7% |

Nine separate node processes run before every Bash tool call, each blocking it: four global
(`weekly-review-readonly`, `scratchpad-guard pre`, and on edits `risky-allow-guard`) and seven from
this repo (`bash-guard`, `push-typecheck-guard`, `module-memory-injector`, `trap-injector`,
`session-lock beat`, `mobile-freeze-guard`, `protected-file-guard`). The guards themselves are
cheap — **process creation is the entire cost**, paid once per hook per call, and it inflates with
memory pressure.

🔴 **Both rows above are CPU, not wait — corrected 2026-10-08, later the same day.** Claude Code
starts every matching hook at once, so a tool call is held for the SLOWEST hook, not the sum: the
1,008ms was ten processes' CPU, while the call itself stood still for roughly one hook's time. The
audit now prints the two apart, like its CI layer — **wait** (the slowest hook, named) and **CPU**
(the sum, over N processes). First reading after the fix, at 3.3 GB free: wait **132ms** per Bash
call (`trap-injector`), CPU **918ms** over 9 processes. The slowest hook timed alone is a FLOOR on
the wait — ten spawns at once contend for the same cores and RAM, so a starved box waits longer than
any one of them. Pinned by `hookWaitIsTheSlowestNotTheSum` in `tests/slow-audit.test.ts`. A
`--history` record from before the fix holds only the sum and is labelled so; the delta skips it
rather than print a fall that never happened.

So the hook total rises and falls with free RAM. Quoting it as an independent cause would send
someone to delete guards that each exist because of a real incident, and would not fix the thing
actually making the box slow. **One dispatcher process in place of nine would return most of it**
and is worth doing on its own merits — roughly 600ms of CPU per Bash call at healthy RAM, which
is spawn churn on a RAM-tight box rather than time each call waits — but it is a second-order win and it is not why the box is slow.

## CI is not the problem

- **Pull request:** `validate` 200s (Test, sharded, 151s) ‖ `checks` 106s (Typecheck 45s). Wait
  **197s**, billed **~6 min**.
- **Push to main:** `validate` 324s (Build 246s) ‖ `checks` 259s (Typecheck 47s + Test 152s) ‖
  `mobile` 55s. Wait **314s**, billed **~12 min**.

For ~6,000 TypeScript files with a full suite, a 3-minute PR gate is healthy. The suite is already
sharded; the typecheck is already ~45s since the move to TypeScript 7. The remaining floor on
`main` is the `next build` at 246s, and that build *is* the production deploy gate (AGENTS.md §2),
so it is not reclaimable. **The wait per shipped change is real — ~3 min on the PR, ~5 min on main,
plus the Railway build — but it is spent on work that has to happen.** What there is a lot of is
*merges*, which is the volume point AGENTS.md §6.1 already makes.

### Two figures that must not be confused

The **critical path** is the slowest job — that is the wait, because jobs run in parallel. The
**billed** figure is the sum, with every job rounded *up* to a whole minute, which is how Actions
charges. On a three-job run the bill is always larger than the wait. Reporting one as the other is
how a wait gets blamed on a bill. The audit prints both, labelled, and `summarizeRun()` keeps them
as separate fields. Dollar amounts are not derived here at all: per AGENTS.md §6.1 the only
authority on what CI costs is the invoice.

## 🔴 A skipped step is `0001-01-01`, not null

The first version of this script reported main's `validate` as **719s of "Test"** on a run that had
built for 246s and skipped Test entirely — on a push event the Test step lives in `checks`, not
`validate`. GitHub reports a skipped job or step with `startedAt: "0001-01-01T00:00:00Z"`;
subtracting that sentinel from a real `completedAt` yields about 63 billion seconds, so a plain
max-by-duration names **the step that never ran** as the step that dominated the job.

It is the fail-open shape `docs/agents-session-traps-clusters.md` already names — an absent answer
arriving in the shape of a very large one — and it needs the guard twice, on jobs as well as steps,
because a wholly skipped job carries the sentinel too. The arithmetic was moved out of a
`gh --jq` expression into `summarizeRun()` in Node specifically so a fixture could reach it;
`tests/slow-audit.test.ts` feeds it that exact payload.

## Firebase

The web app has **no Firebase dependency**: nothing in `package.json`, and no code outside
`supabase/config.toml` and two notification documents. Whatever a Firebase line item covers, it is
not serving the web application, which is the whole scope. The console is the owner's to read.

## What the audit will not do

It is meant to be safe to run on a box already at the freeze line — which is exactly when someone
wants to know why. It starts no dev server, build, typecheck or test run. It may spawn only
PowerShell (counters), `gh` (CI) and `node` (hook probes), and the test asserts that list is
closed. It never times `dev-server-reaper.mjs` (which stops servers) or `scratchpad-guard`'s
`sweep` mode (which archives files) — only the read-only `pre` mode. The probe payload is a
`git status --porcelain`.

That exclusion is asserted against the **declaration**, not the installed-and-filtered list: a
check made against the filtered list silently stops being able to fire on any machine where the
dangerous hook's file is missing. That is not hypothetical — the first version of the test passed a
deliberate break for precisely that reason, and the label and the resolved path are now both
checked, so renaming an entry cannot smuggle one in.

## Thresholds, and where they come from

| Threshold | Value | Why |
| --- | --- | --- |
| `pagesInThrashing` | 5,000 /sec | Above this, measured, every layer stalls at once |
| `pagesInPressure` | 1,000 /sec | Noticeable, not yet dominant |
| `availableFloorMB` | 1,800 MB | `mem-watchdog.ps1`'s own reap floor — kept in sync deliberately |
| `availableFreezeMB` | 1,000 MB | This box has bluescreened below it, with no dump |
| `rendererHotCorePct` | 50% | One Claude process burning half a core or more |
| `hookBudgetMs` | 400ms | Per tool call: the SLOWEST blocking PreToolUse hook — they run in parallel |

## Layer 6 — the second audit, 2026-10-08 evening: compaction and the app's window process

He came back the same evening — *"the slowness of the Claude Code desktop … I will not work like
this"* — and suspected the memory, on a laptop that runs two accounts (sometimes three). Every
account shares the one `~/.claude` folder (transcripts, memory, hooks, settings), so every figure
here covers all of them; only the app's own session-record store
(`%APPDATA%\Claude\claude-code-sessions\<account>\`) is kept per account, and it was reported, not
pruned (his 2026-09-21 ruling keeps all three).

`node scripts/slow-audit.mjs --transcripts --since 2026-10-06`, the baseline for every later run:

| What | 6–8 Oct, 97 sessions | Who can fix it |
| --- | --- | --- |
| **Auto-compactions** | **177, 6.4 hours of frozen sessions** (2.8 h on 8 Oct alone); each p50 **132 s**, p90 194 s; fired at a median 368k tokens and left 130k behind | Mostly how sessions are used — a fresh session costs ~10 s |
| **SessionStart hooks re-run by a compaction** | **1,093** runs on `compact` against 522 at startup; the worktree provisioning sweep p50 1.7 s (worst 17.6 s), the memory index guard p50 2.0 s (worst 11.1 s) | Fixed in this PR (below) |
| **The app's window process** (the Electron renderer) | 1.4–1.6 GB, 80% of a core on average and 127% at peak while sessions work, 3.6% at 2 a.m.; it grows ~120 MB an hour (1.0 GB after 5 h, 1.6 GB after 11 h) | A restart of the app, his click — nothing else returns it |
| **Turn wait by context size** | p50 4.7 s at 100–150k → 5.3 s at 300–400k; p90 ~17–18 s throughout | Smaller fixed load, fresh sessions |
| **Turn-end wait** | slowest blocking Stop hook p50 524 ms, p90 1.0 s — `relay-capture`, which only records | Fixed (below) |
| **The push typecheck wait** | `push-typecheck-guard` p50 4.8 s, p90 146 s, worst 7 min | Already retired on `main` the same day |
| **Text loaded per session** | rules files 316 KB including reloads after each compaction, module memory 54 KB, hook text 116 KB (prompt hooks 54 KB) | Trimmed (below) |

**Was it the memory? Partly.** The memory folder itself (1,307 files, 9 MB) costs nothing per turn —
only `MEMORY.md` (4.7 KB) loads. The rules layer is real: "Memory files" were 32.9k tokens on every
request (global `CLAUDE.md` 18.8 KB, project `CLAUDE.md` 11 KB, `AGENTS.md` 64 KB, `MEMORY.md`
4.8 KB), reloaded after every compaction. But tool output (~50%) and the replies (~25%) fill most of
the window, so the memory layer explains about a fifth of the compactions — not the slowness by
itself.

**What changed, and where it lives:**

- **A compaction no longer re-runs the heavy startup hooks.** `.claude/settings.json` puts the
  provisioning sweep, the memory index guard and the cloud bootstrap under `"matcher":
  "startup|resume|clear"`; `session-lock start` still fires on every source. The same split was made
  in `~/.claude/settings.json` for memory-guard, session-census, the scratchpad sweep, the dev-server
  reaper and needs-you-status; `relay-inject`, `suggestion-context` and the task-rules reminder keep
  firing on compact because the summary drops what they say. Pinned by
  `tests/session-start-memory-index-guard.test.ts`.
- **`relay-capture` no longer holds the end of every turn** — it is `"async": true` in the user
  settings; it writes the baton and prints nothing. `next-step-capture` stays blocking: it enforces.
- **`AGENTS.md` went from 65.4 KB to 51.4 KB.** Every rule kept its line; the evidence moved, word
  for word, into the `docs/` account each one already cited, under "the full wording condensed out on
  2026-10-08".
- **The Claude Docs connector is off in Code** — denied by its bare server name in
  `~/.claude/settings.json` and switched off with the app's own connector switch, which is the one
  that removes its tools from the listing (a permission deny only blocks the calls).
- **The app's window process is watched.** `~/.claude/scripts/ram-meter` now samples it every 30 s;
  above 1.5 GB, or above half a core for 10 minutes, `claude-app-watch.txt` and the tray menu say
  "restart the Claude app" and one notification fires per run of the app. The restart is his click.

**Two things that did not work, recorded so they are not retried:**

- **`skillOverrides` cannot hide the `anthropic-skills:*` skills.** Those are synced from the
  claude.ai account; the setting matches local skill names only (`relay` and `next-step` are hidden,
  the synced ones were still listed in a session started after the change). The only Claude Code
  switch, `syncClaudeAiSkills: false`, drops every synced skill at once — `pptx`, `xlsx` and `pdf`
  with them, which he uses. Turning an unused one off is a per-skill switch on claude.ai.
- **The hook dispatcher was not changed.** Profiled guard by guard, the guards cost 3–75 ms; the
  dispatcher's p50 under load is a node start on a box short of RAM (`docs/hook-dispatcher.md`).

**Compare after the fix** with a window that starts after the merge, e.g.
`node scripts/slow-audit.mjs --transcripts --since 2026-10-09 --until 2026-10-10`. It prints the
change per day against the previous transcript record: compactions and hours, startup hooks re-run
on compact (expected ~0 for the heavy ones), the turn-end wait (expected well under 524 ms) and the
prompt-hook text per session.

## Layer 7 — hook, memory and config, 2026-10-09

The third audit, the next morning, started from his words — *"ur walking the wrong way its in hook
memory config the issue is here"* — and he was right: after Layer 6 the per-call cost of the hooks
themselves was still the largest thing every session paid, and nothing was watching for the next
one. Measured from the transcripts before any change:

| What | Before | Cause |
| --- | --- | --- |
| A Phoenix Read / Grep / Write, tool call to result | 210–260 / 547 / 634 ms, against 45 / 185 / 155 ms before module memory (2 Oct) | every project hook ran through Git Bash first; primary-write-guard started `git rev-parse` on every Write/Edit |
| A Phoenix session start | 2–4 s, about 25 processes at once | the memory index guard re-read 1,225 notes and ran `git ls-tree` + `git cat-file --batch` over the cloud mirror (p50 2.0 s, worst 11.1 s); the all-worktrees provisioning sweep (p50 1.7 s, worst 17.6 s) |
| Relapse | the push typecheck froze commands for 6.1 h over six days, a reminder repeated 440k tokens in 28 h | nothing read the transcripts until a manual audit |

**What changed in this repository:**

- **No shell in front of a project hook.** Every node hook in `.claude/settings.json` is exec form,
  `"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/…"]`, which Claude Code 2.1.293 spawns with no
  shell and still fills `${CLAUDE_PROJECT_DIR}` in (read from its own spawn code; confirmed by three
  headless sessions in the branch, every start-up hook exit 0 and the PreToolUse dispatcher running
  before a Read with no hook error). One Read through the dispatcher: **144 ms through Git Bash, 99 ms
  without** (median of 9 interleaved runs, quiet box). The cloud-only setup script is the one entry
  left in shell form.
- **No git process on an ordinary edit.** `scripts/lib/git-layout.mjs` reads the checkout layout from
  the same `.git` folder, `gitdir:` file and `commondir` pointer git reads (identical to `git
  rev-parse` in 7 real folders), and returns null — so git still decides — whenever it cannot.
  primary-write-guard and bash-guard use it. One Edit through the dispatcher: **156–174 ms → 120–139
  ms**.
- **The mirror drift reading left the blocking path.** `scripts/cloud-mirror-drift-refresh.mjs` runs
  as an `async` start-up entry, takes the same reading the guard used to take (same `readMd`,
  `readCloudMirror`, `cloudMirrorDrift`) at most every 30 minutes, and leaves it in
  `%TEMP%/phx-cloud-mirror-drift-<memory folder>.json`. The guard prints the same "CLOUD MIRROR IS
  STALE" section and alarm from that file when it is under 24 hours old — one start late at most. Its
  three bounded checkout-position git calls stay. The memory folder is resolved in one shared place,
  `scripts/lib/memory-dir.mjs`, so the two can never disagree.
- **The provisioning sweep split in two.** `sync-worktree-env.mjs --hook` provisions only the
  session's own folder and stays blocking, because the session reads the `.env` and
  `settings.local.json` it writes; in the primary checkout it returns without starting a process, and
  in a worktree its seven `git check-ignore` calls became one. `--sweep-only` provisions the other
  worktrees as an `async` entry. Both fail open themselves now that `|| true` is gone.
- **Blocking start-up hooks, measured** (5 interleaved rounds, quiet box, the sweep with `--dry-run`
  on both sides): primary checkout **603 → 202 ms**, worktree **677 → 203 ms**; the memory index guard
  alone 584–595 → 195 ms, the provisioning step 556–585 → 84–123 ms. Inside a real start-up burst on
  this laptop the old pair was 2–4 s.

**What changed on the laptop the same morning** (not in this repository, recorded here so the numbers
add up): `~/.claude/hooks/memory-guard.mjs` and `session-census.mjs` no longer start PowerShell on the
blocking path (1.0–1.1 s → 0.12–0.14 s and 0.6 s → 0.12 s); memory-guard's PowerShell reading moved to
an `async` refresh, and the start-up sweep, reaper and needs-you hooks became `async`.

**What keeps it from coming back:**

- `tests/hook-hot-path.test.ts` runs every blocking hook settings.json names under
  `tests/support/spawn-probe.mjs`, which records every child_process, net, http(s), dns and fetch
  call, with an ordinary Read, Edit, Write, Grep, Glob, Bash `ls` / `git status`, PowerShell
  `Get-ChildItem`, PostToolUse and prompt: each must record nothing. A session start may make only the
  three checkout-position git calls. It also refuses a node hook in shell form and a start-up entry
  that is neither `async` nor on a named list with its reason.
- `scripts/slow-audit.mjs --transcripts --check` folds four more figures — tool wall time split
  Phoenix vs other, the session-start wait (the slowest start hook per start), the share of hook text
  that repeats inside one compaction cycle, and compaction summary length — and judges a day against
  `TRANSCRIPT_LIMITS`:

| Watched | Good state | Alarm when |
| --- | --- | --- |
| Phoenix Read wall time, p50 | 210–260 ms before this change | over 400 ms (at least 50 Reads) |
| Any PreToolUse hook | dispatcher p50 ~540 ms | p90 over 3 s (n ≥ 20), or any run over 60 s |
| Session-start wait, p90 | 2–4 s before this change | over 2.5 s (at least 10 starts) |
| Any UserPromptSubmit hook, p50 | ~390 ms | over 800 ms (n ≥ 20) |
| Turn-end (Stop) wait, p50 | under 524 ms | over 800 ms (at least 20 turns) |
| Repeated hook text | 3% | over 15% (at least 50,000 characters) |
| Compaction summary, median | 6.7k characters | over 10,000 (at least 3), or any in the default nine sections |
| Compaction freeze, p50 | ~59 s | over 90 s (at least 3) |

  Module memory is never measured against a limit (`tests/slow-audit.test.ts` pins that).
- A daily sentinel on the laptop (`~/.claude/scripts/slowness-sentinel.mjs`, Task Scheduler 06:15
  Cairo) runs that check on the previous Cairo day from origin/main's copy of the script and sends any
  crossed limit to his phone through the backup alert's Telegram path, in plain words. It reports
  only; the fix waits for him.

**Not done, and why:** a persistent hook process or an `http` hook server (the guards' own work is
3–75 ms; an HTTP hook fails open when its server is down, silently disabling the delete and push
guards); merging the laptop's context-printing start hooks into one process (small once the
PowerShell spawns are gone — the session-start figure above will show if it is ever worth it). Note
for anyone comparing transcripts across this date: Claude Code records no duration for an `async`
hook, so the rows of the start-up hooks made async disappear rather than shrink.

**After the merge, same day (memory-check speed).** The first real Phoenix start on the merged hooks
(09:04 Cairo) waited longest for the memory-index guard: 1,030 ms, against ~550–660 ms for every
other start hook. Its three checkout-position git calls were ~110 ms of its 193 ms alone, and git
launches slow down sharply when about ten hooks start at once. HEAD's and origin/main's commit ids
are now read off disk (`headAndOriginMain` in `scripts/lib/git-layout.mjs`: loose ref, then
packed-refs; git answers for a shallow clone, the reftable format or anything unreadable), and the
count for a pair of ids is kept in `%TEMP%/phx-checkout-position.json`. A count between two ids
never changes, so the kept answer cannot go stale; a moved HEAD or origin/main is a new pair, and
the first start for it makes two git calls named by id. Measured, interleaved medians: the guard
alone 211 → 94 ms, inside a burst of ten node processes 296 → 175 ms. Both of the owner's Claude
accounts on the laptop share one Windows user and so one temp folder: a start under either account
reuses the other's answer. `tests/hook-hot-path.test.ts` pins that a repeat start makes no git call,
that a moved or packed origin/main is measured again, and that the disk reading matches git in a
worktree and on a detached HEAD and refuses a shallow clone.

## Related

- `AGENTS.md` §5, "Machine limits" and the routing golden rule — free RAM binds, not commit charge;
  default new work to a cloud session.
- `AGENTS.md` §6.1 and `docs/ci-self-hosted-runner.md` — why merge volume, not pipeline speed, is
  the CI bill, and why minutes are never converted into dollars here.
- `docs/agents-worktree-and-machine-limits.md` — the 2026-09-17 reading this file corrects, and the
  Hetzner preview box that keeps a browser look off this laptop.
