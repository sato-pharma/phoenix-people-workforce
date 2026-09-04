# Worktrees, sessions and machine limits — the accounts

Companion to **[AGENTS.md §5](../AGENTS.md)**. That section auto-loads in full on every request, so
it pays for the **hook** — the rule, stated in one line. This file holds the **account**: the
measurements, the dates, the incidents, and the diagnosis traps that cost real time. Same split
§2.1, §2.3 and §4 run under, and the same reason — a multi-paragraph write-up is only wanted once a
session is already looking, and paying for it on every request costs context the conversation would
otherwise have had.

**Adding to this area? Put the hook in AGENTS.md §5 and the account here — never the account there.**

---

## Why a hand-made worktree silently does nothing

`git worktree add` is only step one of four. It never copies gitignored files, so a hand-made
worktree has no `.env.local` — dev-auth and the dev server then fail **silently, with no error** —
and no `node_modules`, so nothing runs at all. By hand the full ritual is `git worktree add` **plus**
`pnpm run worktree:sync-env` **plus** the `node_modules` junction. `node scripts/new-session.mjs
<task>` does all four and refuses to start below 6 GB of free commit charge.

On **2026-08-26** every sibling worktree was measured in exactly that broken state — **zero
`node_modules`, two with no `.env.local`** — so no session could run a test, a script, or a dev
server anywhere but the primary. That is precisely how the collision incidents in this area happen:
everyone is forced back into one folder.

## Why `pnpm` is banned inside a worktree

A `pnpm install` inside a worktree duplicates roughly **1.9M path entries**. Worse, `pnpm run`
**purges `node_modules` outright** once it sees the lockfile has moved, destroying the junction
before your script even starts. Junction from the primary and invoke `node scripts/…` directly.

That junction is enough for `typecheck`, `lint` and `node scripts/…`. It is **not** enough for
`next dev` unless you pass the explicit `--webpack` flag: Turbopack — not Next — reads the junction
as a symlink out of the project root and refuses to start. Measured 2026-08-29: `--webpack` served a
junctioned worktree fine (`Ready in 1770ms`, HMR and all).

**`pnpm exec` is the same trap, and it was not covered by the original wording.** Measured
2026-09-03 in `.claude/worktrees/clever-gauss-58b28f` with pnpm 11.13.1: `pnpm exec next dev
--webpack --port 3000` ran the same deps-status check, tried to purge the junctioned
`node_modules`, aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` and exited 1 without
ever starting Next. The failure is shaped to mislead: the background task reported **exit code
0** while port 3000 stayed dead, so it reads as a `preview_start` permissions or path problem
rather than as pnpm. What works, verified in the same worktree (`✓ Ready in 1154ms`,
`GET /api/healthz 200`):

```
node node_modules/next/dist/bin/next dev --webpack --port 3000
```

`.claude/launch.json`'s `"//"` note named the `pnpm exec` form until 2026-09-03 and now names
this one. `scripts/dev-server.mjs` already resolves Next the same way — through the filesystem,
not through `PATH` — so `node scripts/dev-server.mjs --port 3000` is the equivalent that also
picks the bundler for you.

## When someone runs `pnpm install` in a worktree anyway, nothing reports it

The ban above is behavioural, so it gets broken. When it is, **neither half of the tooling notices**,
and the worktree keeps working — which is what makes it durable.

Measured 2026-09-03 in `.claude/worktrees/interesting-bartik-99eef2`: a real `node_modules` of
**56,553 files**, against the 1-entry junction every healthy worktree has. `repo-doctor` scored that
worktree at **62,478 files and 3,356 links** while its siblings sat at ~5,710 each — 11x, and
**44% of the entire checkout's path weight** in one folder. It reported no defect, because there is
no check for one. The only signal is the file count standing out from its siblings in the LIVE
worktrees table.

Both repair paths are closed, for different reasons:

- **`--repair` never looks.** It skips every `.claude/worktrees/` path by design — *"belongs to
  another live session"* — before any readiness test runs. Verified: `node scripts/new-session.mjs
  --repair` listed nine such worktrees as skipped and reported `0 worktree(s) made runnable`.
- **`ready()` would pass it anyway.** It tests `fs.existsSync(path.join(dir, "node_modules"))` and
  nothing else, so a real directory satisfies it exactly as a junction does. Even reached,
  `linkModules()` returns `"already present"` and replaces nothing.
- **`--remove` refuses the path too**, by the same `.claude/worktrees/` guard.

So the fix is by hand, and it is safe only in this order:

1. Confirm the target is a **real directory**, not a junction — `(Get-Item -Force $nm).LinkType` must
   be empty. `rmdir /s` on a junction removes the link rather than the target, but confirm rather
   than assume.
2. `cmd /c rmdir /s /q "<worktree>\node_modules"`. Never `Remove-Item -Recurse`, which can follow a
   link into the primary. Took 46s for 56,553 files.
3. **Verify the primary's `node_modules` is still intact BEFORE linking** — that is the check that
   catches a step-2 mistake while it is still recoverable.
4. `cmd /c mklink /J "<worktree>\node_modules" "<primary>\node_modules"`.
5. Confirm the junction resolves (`node_modules\next\dist\bin\next` reachable through it) and that
   `.env.local` is still present — together those are what `ready()` calls runnable.

Result: 62,478 files to 5,925, and the checkout's total path entries from 156,266 to 88,210.

**Check for a live process first.** The worktree's own `.next` had been written 20 minutes earlier,
and a `next dev` server was live on port 3000 — but it belonged to a *different* worktree
(`vigorous-gould-7cdf82`, whose parent process named that path) and had taken the port *after* the
last write here. Deleting `node_modules` under a running dev server breaks it instantly, so resolve
which worktree owns the port before touching anything.

## Why the folder name matters

`tsconfig.json`, `eslint.config.mjs` and `.gitignore` all exclude `_wt-*`, `.codex-worktrees/` and
`.claude/worktrees/`. A worktree inside the repo whose folder matches none of those patterns
silently makes every local `typecheck`/`lint` several times slower — confirmed at roughly **12x the
file count, 70s versus 8s**.

## Removal, and why reachability is the wrong gate

`node scripts/new-session.mjs --remove <task>` runs three gates in cost order before touching
anything: the untracked `.xlsx`/`.pdf` rescue scan, then uncommitted work, then commits that are on
no remote branch **and** have no merged PR.

That last gate asks `gh pr list --head <branch> --state merged`, never reachability. PRs here merge
by **squash**, so a merged branch is never an ancestor of `origin/main` and legitimately holds
commits `main` does not. Pure reachability therefore calls **every** successfully merged worktree
"stranded" — and the advice that follows from it, "push the branch", is how you get a conflicting PR
that runs no CI at all. `git branch --merged` is always wrong here.

Stale worktrees must not accumulate: **26 folders** was the historical failure mode.

## The husk that nothing built into git can see

`git worktree remove` deletes the tracked files and the registry entry but leaves the gitignored
payload — `node_modules/` and `.next/` — on disk. What remains has no `.git` file and no registry
entry, so `git worktree prune` cannot find it, and the SessionEnd leg of
`.claude/hooks/worktree-exit-guard.mjs` exits early because `git rev-parse --git-dir` resolves
nothing. Husks accumulate forever and are invisible to every "list the worktrees" check.

**The backup check no longer depends on that leg.** Since 2026-08-23 `bash-guard.mjs` hands any
removal-shaped command to `worktree-exit-guard.mjs --pre-removal`, which reports unpushed commits and
uncommitted files and writes them to `.claude/worktree-exit.log` *before* the directory is deleted.
It never blocks.

The reason that change was needed: the SessionEnd leg had been **silent for a full day while three
worktree sessions ended**, with the hook still registered and the script still on disk. Silence was
its only symptom.

`pnpm run repo:doctor` ([scripts/repo-doctor.mjs](../scripts/repo-doctor.mjs)) reports by default;
`--fix` deletes only husks proven to hold **zero** files, and it refuses to act while more than one
Claude Code session is live. Anything holding even one file is reported NEEDS REVIEW and never
touched.

## Why closing the session does not release the worktree

On 2026-09-01, retiring `_wt-hr-ops-sidebar` cost several hours entirely at this step. The owner
closed the owning session twice and the folder stayed locked. Killing its `claude.exe` released
nothing. `git worktree remove` ran its gates, unlinked the `node_modules` junction correctly, then
failed `Permission denied` on the root — deregistering the worktree and leaving the husk described
above, now empty.

**Every diagnostic available without Sysinternals answers "unattended" while the folder is firmly
held.** A `Win32_Process` sweep for the folder path returns nothing, because a process does not carry
its working directory in its command line. A `ParentProcessId` sweep returns nothing once the
spawning session is dead. The Restart Manager API reports **no holder**, because RM tracks file
handles and a working-directory reference is not one. Windows exposes a process's CWD nowhere else.

`git fsmonitor--daemon` is the prime suspect and was not positively proven. It is spawned by any
`git` command run against a worktree — including the read-only `git -C <worktree> status` typed to
*check* whether the folder is safe to remove — and it outlives the session that spawned it. Three
were running; the oldest had started at 10:07:09, three seconds after the owning session, and was
still alive nine hours later. Its command line is the bare
`git fsmonitor--daemon run --detach --ipc-threads=8` and never names the tree it serves, so it cannot
be attributed to a folder by inspection.

**What was believed to work at the time — corrected below, see the 2026-09-02 supersession:** stop every `git fsmonitor--daemon`, then retry
`rmdir /s /q` over several minutes. Stopping them is free — they hold no state and git respawns one
on demand, so a fresh daemon appearing seconds later is normal and is not the one that was blocking
you. The delete did **not** succeed on the attempt straight after the kills; three attempts across
four minutes still failed, and it cleared about five minutes later. Treat one failed `rmdir` as
inconclusive rather than as evidence the holder is still there.

A background retry loop is the obvious automation and is worth arming, but the one used here died on
launch with exit code 4 and never ran an iteration — so confirm such a job is actually looping before
reporting that it covers the cleanup.

**Superseded 2026-09-02 — the kills were never the mechanism. Quiet time is.** A second occurrence,
while retiring five merged worktrees, isolated the variable the first incident could not. The shape was
identical: `new-session.mjs --remove` ran its gates, unlinked the junction, then failed *Permission
denied* on the root, deregistered the worktree anyway, and left an empty husk — `Get-ChildItem -Force`
reported **0** children and **0** recursive entries.

What the second run adds is the control the first one lacked:

- A background loop that stopped **every** `git.exe` on the machine every 30 seconds and retried
  `rmdir /s /q` ran for roughly ten minutes and **never cleared it**.
- With `(Get-Process -Name git).Count` reading **0** — no git process running at all — both
  `[System.IO.Directory]::Delete($p, $true)` and `cmd /c rmdir /s /q` still failed *"being used by
  another process."* So the holder was demonstrably **not** a `git fsmonitor--daemon`.
- Stopping the loop, leaving the folder completely untouched for **300 seconds**, then trying once
  cleared it on the **first** attempt.

So the operative variable is elapsed quiet time, not force, and the first incident's five-minute wait
was doing the work its kills were credited with. The `Win32_Process` sweep result is unchanged and
still worth knowing: filtering every process's command line for the folder path returned exactly one
hit, the sweep command itself. Sysinternals `handle.exe` was not installed, so the handle table was
never inspected in either incident.

**Refined 2026-09-03 — the holder IS identifiable, and quiet time is not always enough.** Retiring
`.claude/worktrees/wizardly-khorana-65279a` reproduced the shape exactly: payload stripped, junction
dropped with a non-recursive `rmdir`, `git worktree remove` failing *Permission denied* on the root
while deregistering the worktree anyway, husk left holding **0** files and **0** subdirectories. Then
it departed from the 2026-09-02 result. A background job that left every husk on the machine
**completely untouched for 330 seconds** and then tried once cleared **none** of them.

What explains both runs is a lookup the earlier incidents did not have. `list_sessions` reports each
Claude session's `cwd`, and every locked husk matched one:

| Husk | Session whose `cwd` it is | Running |
| --- | --- | --- |
| `interesting-bartik-99eef2` | "Fix 40 marketing contacts whose crm_code points nowhere" | yes |
| `nervous-tesla-4a7d83` | "Offline sync route lets the employee set travel cost and HR fields" | no, idle since 03:18 Cairo |
| `wizardly-khorana-65279a` | the session attempting the cleanup | yes |

So the working-directory reference the OS will not name is still attributable, in one call, from the
session list. Quiet time cleared the 2026-09-02 husk because nothing was pinned to it any more; it
cannot clear one a live session is sitting in, and a session can never clear its own — the harness
resets every shell's working directory back inside the folder on each command. The order is
therefore: look up the holder, close that session, then delete. Waiting is worth doing only once the
lookup says nobody is there.

**And idle is not closed.** A retry 20 minutes later, on a husk whose session had gone idle —
`isRunning: false` in the session list, no activity since — failed exactly as before, as did all
three. The control ran in the same hour: a `_wt-*` sibling worktree created for a docs fix, with no
session ever pinned to it, was removed with `git worktree remove` on the first attempt, exit 0, folder
gone, no husk. Same command, same machine, opposite results.

So `isRunning: false` reports only that the session is not processing a turn. The working-directory
reference belongs to the process and survives idleness indefinitely; the session has to be closed in
the app. Until then the husk is harmless — 0 files, 0 subdirectories, no git registration — and the
only cost of leaving it is a line in a directory listing. Do not escalate: the two available forcings
are `Get-Process git | Stop-Process`, which is machine-wide with four live worktree sessions running,
and killing the holding `claude.exe`, which is killing the owner's own work.

**The dangerous half of the old advice.** "Stop them all" reads as harmless because a daemon is a
cache that respawns — but the command that implements it, `Get-Process git | Stop-Process`, is
**machine-wide**, and on a loop it keeps being machine-wide. A parallel session was live in the
primary checkout throughout this cleanup (its HEAD moved three times while the work ran), so that
loop could have killed a legitimate `git` command out from under it at any point in those ten
minutes. It cleared no husk and risked another session's work. Retry quietly; never arm a repeating
kill.

## Orphaned memory files

Only `MEMORY.md` loads automatically, so a memory file with no index line is **invisible, not merely
hard to find** — nothing recalls it, and the next session re-derives what it already knows.

A sweep on **2026-08-19** found **194 of 734** memory files in that state, the oldest unlinked since
May. `repo:doctor` now reports them (and pointers whose file is gone) in a MEMORY INDEX section;
`--deep` lists every one instead of the first 20. It is read-only and never changes the exit code —
whether an orphan earns a line in `MEMORY.md`, a line in `MEMORY-ARCHIVE.md`, or retirement is a
judgement about what is still true.

## Worktree payload is what makes this checkout feel slow

Measured **2026-08-04**: **1,887,882 file paths, 67 s to walk**, against **4,107 tracked files** — a
**460x amplification, ~99% of it worktrees**.

Tools that honour `.gitignore` never see any of it, which is why validation looks perfectly healthy
while the session crawls. What actually pays the cost is agent file search, `grep -r`, `dir /s`, and
naive watchers.

**Do not tune `tsconfig`/`eslint` for this — those excludes are already correct.** Retire merged
worktrees and clear husks instead. The cost is path **COUNT**, not gigabytes: pnpm hardlinks, so the
disk figure badly understates the damage.

## Why `--strip-idle` no longer takes the session census

**Narrowed 2026-09-01, owner-approved.** `repo-doctor --fix` still refuses to act while more than
one Claude Code session is running. `--strip-idle` no longer does, and the reason is measured
rather than argued: `ram-guard.ps1` has invoked `--strip-idle` every 20 hours since
**2026-08-26**, and the census refused **every single run**, because this repo is worked with 4+
sessions open at all times. A guard that never permits the cleanup is not protecting anything — it
is a cleanup that silently does not exist. Measured the morning of 2026-09-01: **425,638
reclaimable path entries against 5,595 real project files**, doubling inside one night as worktrees
went 3 → 6.

**What replaced it is strictly better informed.** A global process count cannot tell a session
editing *this* worktree from one editing an unrelated folder. `--strip-idle` now answers that
question directly, per worktree, re-reading each signal at the moment of deletion rather than
reusing the inventory taken seconds earlier:

- skips a worktree with **any uncommitted file** — that work exists only on this disk;
- skips one with **any commit found nowhere upstream** — not backed up;
- skips one **touched within 120 minutes** (`--strip-idle=<minutes>` raises the bar);
- verifies `git status` **after** the strip, and reports a strip it could not verify.

The one real risk the census did cover — two repo-doctors stripping at once — is a mutual-exclusion
problem and gets a lock in the **common git dir**, so every worktree of this repo contends on the
same file.

**It deletes only `node_modules` and `.next`, and the junction is safe.** §5 has worktrees
junction their `node_modules` into the primary checkout, so `fs.rmSync(…, {recursive: true})`
looks alarming. Verified 2026-09-01 on a real Windows junction: `lstat` reports it as a symlink,
Node unlinks the link, and **the target survives**. Restore a stripped worktree with
`node scripts/new-session.mjs --repair <task>` — **never `pnpm install` there**, which is what 5
forbids: it would install a real tree over the junction point and duplicate ~1.9M path entries,
the exact cost this flag exists to reclaim.

**A run that strips nothing is a healthy run, not a broken one.** 2026-09-01, all three worktrees
were skipped — two touched within 13 minutes, one holding 3 uncommitted files. Do not reach for
`--force`: it deletes `node_modules` out from under a session that is mid-edit.

## The commit-charge ceiling, and why the old session count was wrong

RAM is soldered at **16 GB** and cannot be upgraded. The pagefile can.

The old guidance — "keep total local sessions at **4 or fewer**" — was written against a ~**19.79 GB**
commit limit (15.79 GB RAM + a 4 GB pagefile). The pagefile went to a fixed 16 GB on **2026-08-25**
(limit **31.79 GB**) and was re-pinned on **2026-08-26** to **32768/65536 MB — a range, not a size.**

The limit is therefore `RAM + the pagefile as currently ALLOCATED`, verified 2026-08-26 at exactly
15.79 + 32.00 = **47.79 GB**, and it **floats up to ~79.79 GB** as Windows grows that file under
pressure, with nothing having been changed. So **47.79 GB is the FLOOR, not the ceiling** — never
treat a bigger number as a reset, and never budget headroom against a limit you did not just read.

Measured live that evening at **9 sessions, 22.96 GB committed, 24.83 GB free**. That makes the old
"4 or fewer" guidance roughly **28 GB too conservative: sessions were never the ceiling.**

Separating the MAIN `claude.exe` from its renderer/gpu/utility children puts an idle session at
**~0.5 GB**, while a dev server, build or cold typecheck is **~3.5 GB** — so the real limit is about
**5 concurrent HEAVY jobs**, not a session count.

Commit is still finite and the failure mode is a **total freeze**, so watch the **headroom** rather
than a fixed session number: `Win32_OperatingSystem.TotalVirtualMemorySize` is the limit and
`FreeVirtualMemory` the headroom, both in KB. `node scripts/new-session.mjs --status` prints both.
**Read them live before quoting any session number.**

Why such a freeze leaves no crash dump, and why `VirtualSize` misleads: AGENTS.md §2.1, *Machine
ceiling*.

### The correction — that relaxation measured the right number for the wrong ceiling (2026-09-04)

**The section above is what produced the incident below.** It retired "4 or fewer" on the strength of
a commit-headroom reading, and the reading was correct: at 9 sessions, commit really was ~28 GB
clear. What was never measured is **physical RAM**, and that is the ceiling that actually binds.

A deep audit on **2026-09-04** found **10 sessions** open, in **31** `claude.exe` processes totalling
**4.65 GB** of working set, beside a `node` process at **3.27 GB**. The two headrooms disagreed
completely:

| Reading | Value | Verdict it gives |
| --- | --- | --- |
| COMMIT free | **54.76 of 79.79 GB** (31.4% used) | healthy — no action |
| Physical RAM free | **557–1,780 MB of 15.79 GB** | at or under the watchdog floor |

`mem-watchdog.ps1` defends a **1,800 MB** floor and logged `PRESSURE` on every 10-second tick for
minutes together, each line ending *"no IDLE dev server to reclaim; left everything running on
purpose."* That is the watchdog working exactly as designed and being **unable to help**: it frees an
idle dev server, and with none running there is nothing it can give back. The only reclaimable thing
left was sessions, and nothing was watching them.

Two numbers moved the estimate. Separating the main `claude.exe` from its children put an idle
session at **~0.5 GB** in the August reading; the September measurement, taken across ten live
engines, puts it at **~330 MB** — *lower* per session, which is why the count could climb so far
before anything hurt. Ten of those plus the Electron shell is still **~4.7 GB of 16**.

**So both statements are true and only one is useful.** Sessions were never the *commit* ceiling.
They are very much the *RAM* ceiling. "Watch the headroom, not a session count" is safe advice only
if *headroom* means both numbers; read against commit alone it certifies a machine that is minutes
from the no-dump freeze in AGENTS.md §2.1. **"4 or fewer" is restored — this time on a RAM basis
rather than a commit one, which is why it now survives a pagefile change.**

**The count was already on screen and that changed nothing.** `statusline.mjs` had been rendering
`9 sessions` for hours — its own source even names "a 4-session rule" in a comment explaining why it
filters Claude Desktop's Electron processes out of the count. A number on a status bar is wallpaper
at 4am after a compaction. Two things were added on 2026-09-04 to make it a control rather than a
display:

- **`~/.claude/hooks/session-census.mjs`** — a `SessionStart` hook. It reports at 5 sessions and
  escalates at 7, or whenever free RAM is under the 1,800 MB floor, at the one moment a session is
  being *added*, which is the only moment the decision is still cheap. It never blocks a session:
  blocking work at 4am to save 330 MB costs more than the memory. Hard-timed-out at 2.5 s, ~670 ms
  typical, and it reads the cache `memory-guard.mjs` already populates rather than paying a second
  PowerShell round-trip.
- **`~/.claude/scripts/claude-hygiene.mjs`** — reports the same two numbers on demand, and clears the
  silt the audit found (stale dead-PID locks, aged `.session-starts`, leaked `.tmp` writes, dead
  `~/.claude.json` project entries, dead permission rules). Report-only by default; `--fix` applies.
  Scheduled weekly, Sundays 03:00, as **`ClaudeCode Hygiene - Weekly`**.

Keep the census floor and `mem-watchdog.ps1`'s floor **in step** — both are 1,800 MB, and a change to
one that skips the other reintroduces exactly the gap this correction closes.

## The dev-server bundler, and why the watchdog sawtooth is NOT a turbopack trait

**Corrected 2026-09-01.** `AGENTS.md` §2.1 previously said the watchdog's 6 GB kills were a
turbopack trait. They are not.

`pnpm run dev` now **chooses the bundler for you** — `scripts/dev-server.mjs` picks webpack on
`win32` and turbopack elsewhere. That platform guard has been deleted three times, most recently by
#1435, so the measurements justifying it live in that file rather than here.

**The measurement that overturned the old claim.** In the 38 minutes *after* that launcher merged
(02:19–02:46 Cairo), **SEVEN** webpack servers were killed at the same ceiling — 6.03–7.23 GB, one
of them started by the launcher itself *with* a memory cap set. That is indistinguishable from the
eight kills before it. All-time: 100 attempts, 98 succeeded. **So the bundler is never the fix for
the kill/restart sawtooth.**

**You cannot attribute a kill to a bundler from `mem-watchdog.log`.** Both bundlers spawn the same
`start-server.js` child, so grepping the logged command line for `turbopack` returns 0 of 100 — which
reads as *no turbopack kill ever happened*. Attribute by **timestamp** instead. And count with
`-CaseSensitive`, or `KILL` also matches every `killed OK` line.

**What turbopack's own failures actually look like:** wedging (no answer to `GET /` in 25–60s), and
the junctioned-`node_modules` refusal documented above. Neither is the sawtooth.

**The sawtooth is a watchdog-THRESHOLD problem.** This dev server legitimately reaches ~6 GB. It was
made acute by running **two** servers at once — the rule is one, ever — because each kill/restart
cycle re-drove RAM to 94% and re-evicted the desktop to the pagefile.

**`--max-old-space-size` cannot help.** Measured a no-op: `heap_size_limit` reads 4288 MB with and
without it, because the growth is off-heap.


---

## `new-session.mjs` — the four-step ritual, and how to undo it

Relocated from `AGENTS.md` §5, verbatim. The sections above describe the worktree rules; this one
describes the script that enforces them, which is the part a session cannot derive by reading them.
A third bullet relocated here on 2026-09-01 duplicated *The husk that nothing built into git can
see* above and was dropped the same day. The cue — and every memory slug — stays in `AGENTS.md`.

- **Start a session with `node scripts/new-session.mjs <task>` — one command for the whole four-step ritual** ([scripts/new-session.mjs](scripts/new-session.mjs), also wired as `pnpm run session:new`; invoke `node` directly per §2.1): fetch `origin/main`, create `_wt-<task>` on `codex/<task>`, junction `node_modules` from the primary, copy the gitignored env files. It refuses to start below 6 GB of free commit charge. `--status` prints live headroom and which folders can actually run, `--repair` fixes a worktree missing either piece, `--from <ref>` branches from something other than `origin/main`. **`git worktree add` is only step one of four** — it never copies gitignored files, so a hand-made worktree has no `.env.local` (dev-auth and the dev server then fail silently, with no error) and no `node_modules` (nothing runs at all). By hand that is `git worktree add` **plus** `pnpm run worktree:sync-env` **plus** the junction.

- **Remove worktrees with `node scripts/new-session.mjs --remove <task>`** (`pnpm run session:remove`), only after approval. It runs three gates in cost order before touching anything — untracked `.xlsx`/`.pdf` rescue scan, then uncommitted work, then commits that are on no remote branch **and** have no merged PR — drops the `node_modules` junction with `cmd /c rmdir` so no husk is left, and re-reads the folder's branch live rather than trusting an earlier scan (a parallel session can repoint a tree first). **A squash-merged branch legitimately holds commits `main` does not**, so the last gate asks `gh pr list --head <branch> --state merged`, never reachability: pure reachability calls every successfully merged worktree stranded, and the advice that follows from it — "push the branch" — is how you get a conflicting PR that runs no CI at all. By hand it is `git worktree remove` plus that same PR check; `git branch --merged` is always wrong here. Stale worktrees must not accumulate.

## Section 5 was trimmed to its floor, and §2.1's `--fix` hook was wrong — 2026-09-01

**What was done.** §5 went from **5,838 → 5,696 bytes, −142 B (2.4%)**. `AGENTS.md` as a whole went
**69,590 → 69,500, −90 B**, because the same pass spent **+52 B** in §2.1 correcting a hook that was
factually wrong about a destructive command. Invariants held across the whole file: **241 bullets,
12 🔒, 15 🔴, 31 memory slugs — an identical slug set before and after.** Proven by arming the guard
first: removing `tailwind-merge-strips-custom-named-font-sizes` made `runMemoryIndexReachabilityTests`
go RED with *"every memory the map marks load-bearing must still be named in AGENTS.md"*; all three
memory-index suites were green after restoring it, and `repo-doctor` reports 0 orphans.

### The §2.1 correction — `--fix` does not exclude `_wt-*`

§5 and §2.1 disagreed about `pnpm run repo:doctor --fix`, which deletes directories. §5 said it
*"deletes only husks proven to hold zero files"*; §2.1 said **"`--fix` can NEVER clear a `_wt-*`
husk"**. Settled against `scripts/repo-doctor.mjs` rather than against either sentence:

- A husk is *"defined by proof, not by name: not registered as a worktree, no `.git` entry, and a
  full recursive walk finding ZERO files"* (header comment). **There is no `_wt-` exclusion anywhere
  in the script** — `else if (files === 0 && !unreadable) husks.push(row)` is the whole test.
- The `--fix` loop re-proves emptiness immediately before each `fs.rmSync`, skipping anything that
  gained a file or became a live worktree since the inventory.
- So a `_wt-*` husk **is** cleared by `--fix` when it holds zero files. What `--fix` cannot clear is
  a husk still carrying its `node_modules`/`.next` payload — reported NEEDS-REVIEW and never touched
  — or one whose `rmSync` fails on the `git fsmonitor--daemon` lock described elsewhere in this file.

§2.1's hook now reads *"`--fix` clears a husk only if it holds ZERO files, and can still FAIL on a
locked one — then use `rmdir /s /q` from PowerShell, not Bash."* That is 52 bytes more expensive and
worth it: the old wording sent a session to hand-delete a folder that the safe, re-proving path would
have removed for it. §2.2 already says a stale hook costs more than a missing one, because it gets
defended rather than looked up.

### What came out of §5

Five edits, each verified to leave no claim without a home:

- **The session-count clause on the husk bullet** (−55). §2.1 states it more precisely and with the
  contrast that matters — *"`--fix` needs exactly ONE live session; `--strip-idle` does NOT"*. §5's
  copy said only "it refuses to act while more than one session is live", which is the weaker half.
- **`(47.79 GB is a floor, not a ceiling)`** (−37). The very next sentence is **"Never budget headroom
  against a limit you did not just read"**, and the two lines after it name the exact WMI fields and
  the `--status` flag that read it. A stale figure sitting in front of that instruction is an
  invitation to do the one thing the paragraph forbids. The floor-not-ceiling *point* survives in the
  retained "**it is not a constant** … so it FLOATS".
- **`gh pr list --head <branch> --state merged` spelled out a second time** (−29). §2's hard-learned
  rules already carry the command verbatim — *"Merged-branch checks must be squash-aware. Use
  `gh pr list --head <branch> --state merged`; `git branch --merged` is always wrong here."* §5 keeps
  the reason, which is the part §2 does not have: **a squash-merged branch legitimately holds commits
  `main` does not.**
- **Two connectives** (−21): "outright" and "of them".

### The finding: the section-by-section campaign is finished

§5 is the third section measured at its floor, after §2.1 (3.7%) and §4 (1.9%). §5 yielded 2.4%, and
as with both earlier passes roughly a third of that came from a duplicate rather than from wording.
The section map after this pass:

| Section | Bytes | State |
| --- | --- | --- |
| 2.1 Session-level traps | 19,060 | trimmed to floor 2026-09-01 |
| 4 + 4.1 Standing owner rules | 13,995 | trimmed to floor 2026-09-01 |
| 5 Session/worktree safety | 5,696 | trimmed to floor 2026-09-01 |
| 2.3 Production and approval hooks | 5,723 | not passed over |
| 3 Stable Environment Facts | 5,520 | not passed over |
| 7 Validation | 3,503 | not passed over |
| everything else (0,1,2,2.2,6,8,9) | ~16,000 | small, mostly structural |

**Do not run another editing pass over §2.1, §4 or §5.** What is left in them is the rules themselves,
and blunting one costs far more than the context it occupies. The two remaining ≥5KB sections (§2.3
and §3) have not been measured and are the only places a further pass could pay.

**The lever from here is the displacement rule applied to new hooks, not more editing.** Every pass so
far has recovered roughly what one or two new hooks add: PR #2880 alone put an 884-byte hook into §2.1
on the morning §2.1 was trimmed by 729. Cue in `AGENTS.md`, account in `docs/`, at the moment the hook
is written.

## The worktree accounts, moved out of `AGENTS.md` §2.1 on 2026-09-04

§2.1 had been trimmed to a floor of 19,059 bytes on 2026-09-01 and grew 4,497 bytes in the three
days after, most of it here — the same regrowth the 2026-09-01 consolidation was written to undo.
These are the bullets **verbatim as they stood**; the hooks that replaced them keep every rule, and
what left is measurement, narrative, and what §5 already states. Search this section by wording.

- **`--fix` needs exactly ONE live session; `--strip-idle` does NOT** — it gates per worktree on dirty/unpushed/120-min-idle behind a lock, so RUN it with sessions open; the old census meant it never once ran. **`--fix` clears a husk only if it holds ZERO files, and can still FAIL on a locked one** — then use `rmdir /s /q` from PowerShell, not Bash.

- **`--repair` SKIPS every `.claude/worktrees/` path, and `ready()` counts a REAL `node_modules` as fine** — so a stray `pnpm install` in one is invisible to BOTH tools: `--repair` never looks, `linkModules` answers "already present" instead of replacing the directory, and `--remove` refuses the path too. Nothing reports it as a defect — the only tell is repo-doctor's file count against its siblings. Fix it BY HAND: `rmdir` the real directory, then `mklink /J` to the primary's.

- **Closing the session does NOT release its worktree, and the release is not INSTANT.** `git worktree remove` then fails *Permission denied*, deregisters anyway, and leaves the husk. **No OS tool points at the holder** — a `Win32_Process` sweep, a `ParentProcessId` sweep and the Restart Manager API all report NOTHING, because a working-directory reference is not a file handle — **but `list_sessions` DOES: match the husk's path against every session's `cwd`.** **Quiet time frees it only once NO session is pinned there — and IDLE is not CLOSED**: `isRunning: false` means only that the session is not mid-turn, so its `cwd` reference survives and waiting stays futile until the process exits. Three husks survived 330s of untouched quiet; a retry 20 minutes later, after one holder went idle, still cleared none. `git fsmonitor--daemon` — spawned by ANY `git -C <worktree>`, **your own read-only gate scans included** — outlives the session, but is NOT the mechanism: the lock held with ZERO git processes running, then cleared on the FIRST `rmdir /s /q` after 300s of **not touching the folder**. Look the holder up FIRST and close that session; a session can NEVER clear its own husk, since every command it runs resets its working directory back inside the folder. **NEVER kill git machine-wide on a loop** — `Get-Process git | Stop-Process` hits every session, and a parallel one is usually live.

- **A DEREGISTERED worktree is worse than a husk — a shell still sitting in it resolves git against the PRIMARY checkout**, silently. `git rev-parse --absolute-git-dir` returns the primary's `.git` and `git log -1` reports whatever branch IT has out, usually `main`, so a commit lands on PRODUCTION's branch with no error. **`cd` cannot escape it** — the shell RESETS its cwd back inside the husk after every command, so address the real repo with `git -C <path>`. Path-filtered reads LIE there too: `git log -- <path>` and `ls-tree | grep <path>` both came back EMPTY for a file `git show` read 127 lines from, so verify with a POSITIVE CONTROL (bytes read, fields found), never a clean-looking blank.

- **Self-removing a worktree MUTES its own session-end guard — and a `.claude/worktrees/` one canNOT retire itself at all.** `ExitWorktree` no-ops on any worktree it did not create in THAT session, and `change_directory` refuses to move a session pinned to one ("runs in an isolated worktree"), so the session's own cwd holds the folder and `git worktree remove` deregisters-then-husks every time. **So strip the payload FIRST, while you still can**: drop the junction with cmd's NON-recursive `rmdir` (never `Remove-Item -Recurse`, which can follow it into the primary), then `.next`. The husk then holds ZERO files — the only state `--fix` above will clear. Do it in the other order and the husk keeps its payload, and only quiet time and a hand `rmdir /s /q` will shift it.

- **`next dev` in a worktree needs the explicit `--webpack` flag** — TURBOPACK rejects the §5 junction, not Next; `pnpm run dev` now chooses for you (`scripts/dev-server.mjs`). **The watchdog's 6 GB kills are NOT a bundler trait** — SEVEN webpack servers died at the same ceiling. It is a watchdog-THRESHOLD problem: this server legitimately reaches ~6 GB, made acute by two servers at once, and `--max-old-space-size` is a measured no-op because the growth is off-heap.

- **`gh pr merge` from a worktree exits NON-ZERO after the merge SUCCEEDED.** `fatal: 'main' is already used by worktree` is its LOCAL post-merge step failing, never the merge — and it fires on EVERY merge here, since the primary holds `main`. Treat a non-zero exit as UNKNOWN, not failed: `gh pr view <n> --json state,mergeCommit`; `MERGED` means done and only the local branch is left. Retrying errors on an already-merged PR and reads like a worse failure. `gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded`


## `list_sessions` reports where a session STARTED, not where it works — 2026-09-04

`AGENTS.md` §2.1 said: *"No OS tool points at the holder — but `list_sessions` DOES: match the husk's
path against every session's `cwd`."* The second half does not hold here, and it fails in the
dangerous direction — it reports a busy worktree as empty.

### The measurement

At 13:23 Cairo, `list_sessions` returned 12 sessions. **Every one reported
`F:\Phoenix Workforce\phoenix-workforce`, the primary checkout.** Not one named a worktree.

At that same moment four worktrees held live work:

| worktree | evidence it was live |
| --- | --- |
| `_wt-admin-identity-strip` | HEAD moved `ed609554a` → `e76aed1b8` → `cdc912bf0` |
| `_wt-kpis-window` | fresh branch cut 4 min earlier; went clean → dirty within minutes |
| `_wt-portal-sticky-nav` | held the only running dev server (port 3000) |
| `_wt-staging-migration-autoapply` | HEAD moved `8e681bac4` → `8c5014ae5` |

The decisive case is `_wt-admin-identity-strip`. The session titled "Admin identity banner Phoenix
logo positioning" reports `prNumber: 3070` and `cwd` = the primary. PR #3070's `headRefName` is
`codex/admin-identity-strip`, and `git worktree list` shows that branch checked out **only** in
`_wt-admin-identity-strip`. A session cannot be committing to a branch that is checked out in another
folder, so `cwd` is simply the folder the session was launched in — not the one it is working in.

### Why it matters

§5's removal ritual leans on "is anybody in this folder". Run as a `cwd` sweep it returns *nobody*
for every worktree on this machine, always — so the gate passes on folders in active use, and the
failure mode is deleting someone's live work.

That nearly happened on 2026-09-04. `repo-doctor` reported `_wt-kpis-window` RETIRABLE (PR #3068
merged, HEAD unmoved since); `list_sessions` showed no session in it; the tree was clean; all ten
spreadsheets and PDFs inside it were tracked and unmodified. Four gates, all green — on a folder
whose owner had cut a fresh branch four minutes earlier. What stopped the removal was reading the
branch and HEAD **live at the moment of removal** and finding they no longer matched the scan:
`codex/call-rate-standard` @ `23bb098a2` had become `codex/call-rate-never-averaged` @ `28fb7a40d`.

### The check that does work

Match the folder's branch against the open PRs — `gh pr list --state open --json number,headRefName`
against `git worktree list` — and re-read HEAD immediately before removing, comparing it against the
SHA read at the gate. Branch identity survives and is observable; `cwd` never described it.

## `repo-doctor --force`, and the guard that erodes by design — 2026-09-04

`AGENTS.md` documents `repo-doctor`'s `--fix`, `--deep` and `--strip-idle`. It has never mentioned
`--force` or `--no-auth`, and both matter.

### What `--force` actually switches off

`scripts/repo-doctor.mjs` parses exactly five flags: `--deep`, `--fix`, `--force`, `--no-auth`,
`--strip-idle` (also `--strip-idle=<minutes>`). `--force` appears in two guards:

| line | guard | what `--force` does |
| --- | --- | --- |
| `if (fix && !force)` | the concurrent-session census | skips it entirely |
| `if (stripIdle && !force)` | the strip-idle mutual-exclusion lock | skips it entirely |

**It does NOT weaken the zero-file proof.** The deletion loop (`if (fix) { … }`) is not gated on
`force`, and it re-walks each husk immediately before removing it:

```js
const recheck = walk(r.dir);
if (recheck.files !== 0 || recheck.unreadable) {
  console.log(`  SKIPPED ${rel(r.dir)} — it now holds ${num(recheck.files)} file(s).`);
  continue;
}
```

So `--fix --force` still cannot delete a directory holding a single file, and the
"never delete a `.xlsx` or `.pdf`" rule remains satisfied by construction. **The exposure is not a
wrong deletion — it is two sessions cleaning at once**, which the script's own comment calls
"this repo's documented incident pattern (AGENTS.md section 5)".

### Why the guard erodes rather than holds

Both failure paths end by naming the override:

- *"…concurrent cleanup is how this repo lost work before. **Pass `--force` if you are sure.**"*
- *"…Close the others, or **pass `--force` if you are sure**."*
- *"…Wait for it, or **pass `--force` if you are sure it is dead**."*

Measured on 2026-09-04 at 17:10 Cairo, running the census's own command:

```
powershell -Command "@(Get-Process claude | Where-Object { $_.Path -like '*claude-code*' }).Count"
→ 11
```

`new-session.mjs --status` agreed (`claude sessions running: 12`, counted a moment apart). **The
census refuses at anything above 1.** On this machine that is the ordinary state, not an exception —
so a session following `AGENTS.md` §5's instruction to run `repo:doctor` after every removal meets a
refusal nearly every time, and the only route forward the tool offers is `--force`. That is how a
safety guard becomes a habit to type past.

The census additionally **fails closed**: it refuses when it cannot *establish* a count at all — a
non-Windows host, a timeout, a renamed binary — with the same "pass `--force`" wording. So the
identical message appears when nothing is wrong, which further trains the override. Failing closed is
the right design (the comment cites PR #1727 for why the earlier fail-open version was a bug); the
problem is only that `AGENTS.md` never told anyone the escape hatch exists or what it costs.

**Guidance:** close the other sessions. If you must override, override `--strip-idle` (which deletes
only caches `new-session.mjs --repair` restores) and not `--fix` (which deletes directories).

### `repo:doctor` is read-only, but it is not local

`AGENTS.md` §5 ended its memory-index bullet with *"It is read-only."* True — and misleading, because
it reads as *local*. By default the script runs an ORPHAN AUTH USERS section that:

1. reads `.env.local` from the primary checkout for `NEXT_PUBLIC_SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`;
2. pages `/auth/v1/admin/users?page=N&per_page=1000` **up to 50 times**;
3. pages `/rest/v1/app_auth_users?select=hr_id&limit=1000&offset=…`.

`.env.local` on this machine resolves to project **`ozucdzovmcqvepbozvqf`** — PRODUCTION (verified
2026-09-04 by reading the host portion only; the key was never printed).

The script itself is scrupulous about this: it prints the project ref before querying, and its comment
cites §8's requirement that the target be shown. **The defect was in `AGENTS.md`, not in the script.**

This connects to a hook already in §2.3 that nothing linked to it: *"ONE `auth.users` row with
`banned_until = 'infinity'` 500s the ENTIRE GoTrue admin API — page-shaped, so a small `per_page`
probe passes."* repo-doctor pages at `per_page=1000`, the largest page GoTrue allows — precisely the
shape that trips it. So the command most likely to hit that production landmine is the one presented
as local housekeeping. `--no-auth` skips the leg; every other section is unaffected.
