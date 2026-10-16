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
`node scripts/sync-worktree-env.mjs` **plus** the `node_modules` junction. `node scripts/new-session.mjs
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
rather than as pnpm. What worked, verified in the same worktree (`✓ Ready in 1154ms`,
`GET /api/healthz 200`), was invoking Next's binary through node — and the launcher does exactly
that, resolving Next through the filesystem rather than through `PATH`. Since 2026-09-21 it is the
only form to use:

```
node scripts/dev-server.mjs --port 3000
```

It picks `--webpack` on Windows, caps the server's heap at 4,096 MB, and refuses to start a second
dev server. The raw form this section used to print — Next's own binary run with `dev` — skips
all three: Next then hands the server half of RAM (see "The dev server's heap cap" below), and
`.claude/hooks/bash-guard.mjs` C7 now denies it. `.claude/launch.json`'s `"//"` note named the
`pnpm exec` form until 2026-09-03, the raw form until 2026-09-21, and names the launcher now.

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

## Worktree payload slows tree-walking commands — not the machine

Measured **2026-08-04**: **1,887,882 file paths, 67 s to walk**, against **4,107 tracked files** — a
**460x amplification, ~99% of it worktrees**. Still true, and still worth the hygiene: the repo's own
Bash guard refuses a recursive grep here because ~346k path entries take 10–40 s to scan.

Tools that honour `.gitignore` never see any of it, which is why validation looks perfectly healthy
while a tree-walking command crawls. What pays the cost is agent file search, `grep -r`, `dir /s`,
and naive watchers — **those commands, and nothing else.**

🔴 **CORRECTED 2026-09-17 — this section used to claim payload is what makes the CHECKOUT slow, and
sessions read that as the cause of the MACHINE being slow and retired worktrees over it.** It is not.
Measured on this box the same evening, while it was slow: **PhysicalDisk 99.6–99.9% idle with a
current queue length of 0.00** across repeated samples — an idle disk cannot be the bottleneck for
path walking. In the same 20 s window the **desktop app's own 39 UI processes took 6.4% of the whole
box against 1.5% for all 13 Claude Code session processes combined**, and held **3,623 MB of RAM
against 3,928 MB for every session together**, with **1,977 MB free of 16,174 MB**. A parallel
session sampling under load saw the same shape wider apart — 26.1% against 1.8%.

So: **free RAM is the binding resource, and the number of open SESSIONS is the only real lever —
which is the owner's call and nobody else's.** Retire a merged worktree because your own commands
will be faster, or because it is finished; never tell him it will make the machine quicker, and
never retire someone else's tree on performance grounds.

**Do not tune `tsconfig`/`eslint` for this — those excludes are already correct.** The cost is path
**COUNT**, not gigabytes: pnpm hardlinks, so the disk figure badly understates the path damage.

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
- skips one **a live process holds** — a cwd inside it (PEB sweep), a Claude transcript written
  inside the hold window, **or a running process whose command line, or the script it runs, names
  the folder** (`scripts/worktree-references.mjs`). That last one is the parked job: on 2026-09-17
  `cd "<wt>" && node wait-for-dev-window.mjs && next dev` sat queued with its waiter's cwd in the
  primary, so no file in the worktree moved for 120 minutes and the strip emptied it. Files
  untouched for two hours cannot tell a finished session from one parked behind a waiter. An
  unreadable process list refuses, like every unknown in this family;
- verifies `git status` **after** the strip, and reports a strip it could not verify.

The one real risk the census did cover — two repo-doctors stripping at once — is a mutual-exclusion
problem and gets a lock in the **common git dir**, so every worktree of this repo contends on the
same file.

**It deletes only `node_modules` and `.next`, and the junction is safe.** §5 has worktrees
junction their `node_modules` into the primary checkout, so `fs.rmSync(…, {recursive: true})`
looks alarming. Verified 2026-09-01 on a real Windows junction: `lstat` reports it as a symlink,
Node unlinks the link, and **the target survives**. Restore a stripped worktree with
`node scripts/new-session.mjs --repair <task>` (`--repair --nested` for a `.claude/worktrees/*`
folder: it re-links a missing `node_modules` and writes nothing else). **Since 2026-10-14 the strip
does not touch a `node_modules` that is a link at all** — it frees nothing, and losing it stops
`next` resolving in a folder a session may still be using — so only `.next` and a *real*
`node_modules` folder are payload. And **never `pnpm install` there**, which is what 5
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

### The dev server's heap cap

**Corrected 2026-09-21: `--max-old-space-size` DOES bind the dev server.** Until that day this
section said it was "a measured no-op: `heap_size_limit` reads 4288 MB with and without it, because
the growth is off-heap". That reading came from a plain `node`, whose own default on this machine is
about 4 GB — never from the process that grows. That process is the `start-server.js` child Next
forks, and Next sets that child's limit itself (`next/dist/cli/next-dev.js`, 16.3.3): when
`NODE_OPTIONS` carries no `--max-old-space-size`, it gives the child **half of RAM**
(`--max-old-space-size=8086` here). Next restarts the child in place only when a request finishes
with more than **80%** of that limit in use (`getMemoryRestartStats` — the log line is "Server is
approaching the used memory threshold, restarting..."). So at the default a busy server climbs past
6.6 GB of heap before anything happens; the watchdog stopped one at **8.14 GB** at 09:07 Cairo on
2026-09-21, and another reached 7.5 GB within seven minutes the same morning.

Measured on that child with a `--require` probe reading `v8.getHeapStatistics()`:

| How the server was started | The child's heap limit |
| --- | --- |
| a raw `next dev`, or the launcher before 2026-09-21 | **8,278 MB** |
| `node scripts/dev-server.mjs` — the 4,096 MB default | **4,288 MB** |
| `PHOENIX_DEV_HEAP_MB=3072` | 3,264 MB |
| the caller's own `NODE_OPTIONS=--max-old-space-size=6144` (always wins) | 6,336 MB |
| `PHOENIX_DEV_HEAP_MB=0` (the choice handed back to Next) | 8,278 MB |

With the cap, Next restarts the server in place near 3.4 GB of heap, so the process as a whole tops
out around 5–6 GB instead of climbing to 8. **What no heap cap reaches:** a cold compile of a heavy
page holds about 3.4 GB in all, up to 1.4 GB of it in ArrayBuffers outside the heap — measured on
`/admin/approvals-hub`, the same with the cap at 2,560 and at 4,096. The cap bounds the long-run
growth, not the first compile.

**Why 4,096 and not lower** (2026-09-09, the same ten admin routes from cold): no cap peaked at 5,933
MB of commit with a slowest route of 14.1 s; `--max-old-space-size=3072` peaked at 4,835 MB, but its
slowest route took 62.1 s. `--disable-source-maps` saves only 50–70 MB and costs mapped stack traces.

**Every start path goes through the launcher** — `package.json`'s `dev`, `dev:webpack`,
`dev:turbopack` and `dev:no-turbopack`, `scripts/dev-supervisor.ps1`, AGENTS.md §5 and
`.claude/launch.json` — and `.claude/hooks/bash-guard.mjs` C7 denies a raw `next dev` at the
command line. Pinned by `tests/dev-server-heap-cap.test.ts` (including Next's own reader of the cap
and its 80% restart, so an upgrade that drops either goes red) and `tests/raw-next-dev-guard.test.ts`.


---

## `new-session.mjs` — the four-step ritual, and how to undo it

Relocated from `AGENTS.md` §5, verbatim. The sections above describe the worktree rules; this one
describes the script that enforces them, which is the part a session cannot derive by reading them.
A third bullet relocated here on 2026-09-01 duplicated *The husk that nothing built into git can
see* above and was dropped the same day. The cue — and every memory slug — stays in `AGENTS.md`.

- **Start a session with `node scripts/new-session.mjs <task>` — one command for the whole four-step ritual** ([scripts/new-session.mjs](../scripts/new-session.mjs), also wired as `pnpm run session:new`; invoke `node` directly per §2.1): fetch `origin/main`, create `_wt-<task>` on `codex/<task>`, junction `node_modules` from the primary, copy the gitignored env files. It refuses to start below 6 GB of free commit charge. `--status` prints live headroom and which folders can actually run, `--repair` fixes a worktree missing either piece, `--from <ref>` branches from something other than `origin/main`. **`git worktree add` is only step one of four** — it never copies gitignored files, so a hand-made worktree has no `.env.local` (dev-auth and the dev server then fail silently, with no error) and no `node_modules` (nothing runs at all). By hand that is `git worktree add` **plus** `node scripts/sync-worktree-env.mjs` **plus** the junction.

- **Remove worktrees with `node scripts/new-session.mjs --remove <task>`** (`pnpm run session:remove`), only after approval. It runs three gates in cost order before touching anything — untracked `.xlsx`/`.pdf` rescue scan, then uncommitted work, then commits that are on no remote branch **and** have no merged PR — drops the `node_modules` junction with `cmd /c rmdir` so no husk is left, and re-reads the folder's branch live rather than trusting an earlier scan (a parallel session can repoint a tree first). **A squash-merged branch legitimately holds commits `main` does not**, so the last gate asks `gh pr list --head <branch> --state merged`, never reachability: pure reachability calls every successfully merged worktree stranded, and the advice that follows from it — "push the branch" — is how you get a conflicting PR that runs no CI at all. By hand it is `git worktree remove` plus that same PR check; `git branch --merged` is always wrong here. Stale worktrees must not accumulate.

### The retune — the count was the wrong instrument (2026-09-04, the same night)

**"4 or fewer" lasted about an hour.** Shown the rule above, the owner answered plainly: *"LEAVE THEM
THEY ARE ACTIVE WORK"*, then *"10 sessions, retune the thresholds"*. A re-measure settled it in his
favour, and the correction is not a concession — the first version blamed the wrong term.

| Term | Measured 2026-09-04, 23:5x Cairo | Share of 15.79 GB |
| --- | --- | --- |
| 11 agent processes — one per session | 2,964 MB total, mean **269 MB** | 18% |
| Desktop app shell — 26 processes, fixed | 1,760 MB | 11% |
| **ONE `next dev`** — PID 3976, port 3011 | **3,454 MB** | **21%** |

Three things follow, and each contradicts the section above.

**The per-session figure was too high.** August separated the main `claude.exe` from its children and
got ~0.5 GB; September's first pass got ~330 MB; measured across eleven live engines it is **269 MB**.
The owner's normal ten are **~2.7 GB of 16** — which 16 GB absorbs without complaint.

**One dev server outweighed every session put together.** 3,454 MB against 2,964 MB for all eleven.
The incident that produced the original rule had ten sessions *and* a 3.27 GB `node` process, and it
was the second term that broke it. Free RAM was also observed falling **2,969 → 750 MB in about four
minutes with no session opening** — a dev server growing, invisible to any count.

**A guard that fires at the owner's normal working level is wallpaper.** This section already records
that failure once: `statusline.mjs` rendered `9 sessions` for hours and nobody acted. A hook warning
at 5 and escalating at 7, on a machine that habitually runs 10, reaches the identical end by a
different route — it would have fired an escalated warning on *every* session start.

**So the trigger is free RAM, and the count is only context.** `session-census.mjs` was rewritten:

| Constant | Value | Why that number |
| --- | --- | --- |
| `RAM_FLOOR_MB` | 1,800 | `mem-watchdog.ps1`'s own floor — the two must stay in step |
| `RAM_WARN_MB` | 2,600 | below it, a dev server or cold typecheck (~3.5 GB) crosses the floor |
| `WARN_AT` / `STOP_AT` | 13 / 16 | ~3.5 / ~4.3 GB of session overhead — a runaway, not a busy night |
| `CEILING` | 10 | the owner's stated working level; printed as context, **never a trigger** |

When it does speak it names the dev server **first**: stopping one returns ~3.5 GB where closing a
session returns ~269 MB, and it must be killed by PORT, not by task (§5). It still never blocks a
session and still kills nothing itself.

**Proved by forcing each branch rather than by reading the code.** With both RAM triggers disabled,
eleven sessions produced **silence** — the property the owner actually asked for. Raising the floor
above current free RAM fired the floor branch; disabling only the floor fired *"RAM is tight"*;
lowering `STOP_AT` to 2 fired the runaway branch. The floor branch also fired for real, unprompted,
at 975 MB free while these tests were running.

## The watchdog reached BUSY node jobs, and a gate refused to start one — 2026-09-09 and 2026-09-11

**What went stale.** Until 2026-09-11 §5's physical-RAM hook ended its floor sentence with:

> under **1,800 MB** you are already in it, and the watchdog reclaims NOTHING unless an IDLE dev
> server exists.

It was true when written — it is the 2026-09-04 reading above, *"no IDLE dev server to reclaim"* —
and two changes to `~/.claude/scripts/mem-watchdog.ps1` plus one new hook have made it false since. A
session that believed it would treat the floor as a place where nothing intervenes, when by then the
watchdog reached busy dev servers too and, under a lower floor, any node job. The hook then read:

> Under **2,600 MB** a dev server or cold typecheck crosses `mem-watchdog.ps1`'s floor and
> `~/.claude/hooks/heavy-job-gate.mjs` refuses to START one; under **1,800 MB** the watchdog reaps
> IDLE dev servers, then all but the most recently active, and under **500 MB** ANY node job, most
> RAM first.

The list is deliberately **not exclusive** — it never says "only" — so rules added later (rules 8
and 9 below) extend it without making it false again.

🔴 **That quoted hook text is itself now history, in BOTH halves.** The gate it names was retired on
2026-09-17 (see *The heavy-job gate — RETIRED 2026-09-17* below), so nothing refuses a heavy job any
more. And the watchdog stopped reaching dev servers on **2026-09-12**: rules 0 through 9 all skip
one, and `mem-watchdog.ps1`'s own header now says so in as many words —

> A NEXT DEV SERVER IS THEREFORE TOUCHED BY NOTHING IN THIS SCRIPT AT ALL

The exemption is reversible only by `PHX_DEV_KILL_EXEMPT=0` or the script's `$DevServerKillExempt`
switch, and re-arming it is the owner's call, not a session's. **So read every "reaps idle/busy dev
servers" line in the rules below as what the script did between 2026-09-09 and 2026-09-12.** Under
its floors today it reclaims NODE JOBS — a typecheck, a build, a test run — and what stops a dev
server is `~/.claude/hooks/dev-server-reaper.mjs` (see the retirement subsection below).

🔴 **Amended 2026-09-21: the owner re-armed TWO of those rules for a dev server** (next subsection).
Rule 1 stops one at or over 8 GB of commit, and rule 3 stops one that has done no work for 25 minutes.
Every other rule still skips it.

### 2026-09-21 — rules 1 and 3 re-armed for a dev server (owner's choice)

**What happened.** From 06:40 Cairo a browser-pane tab was stuck in a redirect loop.
`/employee-portals/expense-dashboard` sends a Medical Rep to `/employee-portals/expenses`, and that page
sends the viewer back when the expense service refuses anyone whose EMPLOYEE record is not a Medical
Rep. The tab bounced about once a second, and every hop re-fired the portal's heartbeat, activity and
notification calls. It drove one `next dev` child to **9.9 GB of commit (5.7 GB resident)** for over an
hour, and available RAM sat between **500 and 1,800 MB**. Nothing on the machine could stop it:

- every rule in `mem-watchdog.ps1` skipped the server under the 2026-09-12 exemption;
- `dev-server-reaper.mjs` only acts when the owning session ends.

The session restarted its server at 08:03 and again at 08:12, and the tab's loop started again on each
new one.

**The decision.** He was asked what the watchdog should do with dev servers from now on, and chose
**"Over 8 GB or unused 25 min"**:

| Rule | For a dev server, since 2026-09-21 |
| --- | --- |
| 1 — per-process ceiling | **stops** one at or over `$KillGB` (8.0 GB of commit). Healthy servers peaked at 6.03–7.23 GB (2026-09-01), so only a runaway gets there |
| 3 — abandoned server | **stops** one that holds 0.75 GB or more and does less than 1 CPU-second of work across 25 minutes |
| 0, 2, 4, 5, 6, 7, 9 | unchanged — they still skip it, so a server in use under 8 GB is never touched, however low RAM runs |

The watchdog stops only the `start-server.js` child, and that is enough. `next dev` exits whenever its
child exits with anything but Next's own restart code (`next/dist/cli/next-dev.js`, `child.on('exit')`),
and `scripts/dev-server.mjs` exits with it. Nothing respawns in a loop.

**Proof.**

- The loop and the self-test call the same pure function, `Get-DevServerVerdict`, for both verdicts.
- `PHX_DEV_EXEMPT_SELFTEST=1` passes 24 of 24 cases. They include controls on each side of both
  thresholds, on the disarm switch and on rules 4 and 7, plus a check that the shipped defaults are
  armed.
- Rolled back to the 2026-09-12 behaviour, the self-test failed 4 cases. With the switch shipped off,
  it failed 1.
- **Switches:** `PHX_DEV_RUNAWAY_STOP=0` disarms both rules. `PHX_DEV_KILL_EXEMPT=0` still re-arms every
  rule.
- The pre-change script is `~/.claude/scripts/mem-watchdog.ps1.bak-20260921-0814-pre-dev-rearm`.

**Not changed:** the redirect loop itself. That is a code fix, handed to its own session.

### 2026-09-09 — rule 5: concurrent dev servers, all of them BUSY

**Two hard freezes, 17:34 and 20:36 Cairo.** Neither left a minidump; both left a GPU watchdog dump
(`WATCHDOG-20260909-1734.dmp`, `-2038.dmp`, video timeouts 0x117 and 0x141). In the hour before the
second, available RAM swung between 10 MB and 1.5 GB against the 1,800 MB floor, node held
5.1–8.6 GB across four to seven processes, and the last line the watchdog wrote was 20:35:54 at
**164 MB**. Every PRESSURE line that day ended "no idle dev server": the servers were all busy, each
legitimately compiling and each under the 8 GB per-process ceiling, together larger than the box.
Every earlier rule keyed on ONE process being wrong; nothing looked at the COUNT.

**Rule 5 is §5's "one dev server at a time, ever", made mechanical under pressure and only there.**

| Property | Value |
| --- | --- |
| When it runs | only from rule 4's "nothing idle to reclaim" branch — RAM under `$LowRamMB` (1,800) for 3 polls, rule 0 already trimmed |
| What counts as a server | a `next dev` match of at least `$MultiNextMinGB` (1.0 GB); below that it is the cheap parent |
| What it does | keeps the most recently active server, reclaims every other one in the same pass |
| Then | leaves the survivor alone for `$MultiNextCooldownSec` (900 s), counted only from a kill that succeeded |
| Proof | a 5-case decision self-test and a dry-run live test; as of 23:57 Cairo on 2026-09-11 the log holds **no `MULTI` line**, so it has never fired for real |

Killing a BUSY server is safe here where the 2026-09-03 sawtooth was not: that sawtooth killed the
ONLY server, relieving nothing. This fires only when there is more than one, under the floor.

### 2026-09-11 — two bluescreens in 18 minutes, and rule 7

Commit charge sat at **33–35%** the whole evening, so rules 1, 2 and 6 (per-process 8 GB, commit 92%
or 7.5 GB, the kernel job cap) were never near firing. **These were bugchecks with minidumps — a
different signature from §2.1's no-dump freeze**, and `nvlddmkm` is again the symptom: starved of
physical RAM, the graphics driver cannot page its own allocations back in and times out. Cairo time,
from `mem-watchdog.log`, `heavy-job-gate.log` and the System event log:

| Time | Event |
| --- | --- |
| 22:05:04 | rule 4 KILL pid 25416, node 5.52 GB, at 1,030 MB available |
| 22:13:48–22:19:50 | rule 0 trims; available reaches **168 MB** at 22:19:50 |
| 22:21:04 | PRESSURE 921 MB — "node x3 5169MB, msedge x36 2928MB, claude x39 2876MB", no idle dev server |
| 22:24:07 | PRESSURE 1,571 MB — the last watchdog line before crash 1 |
| **crash 1** | bugcheck **0x9F** DRIVER_POWER_STATE_FAILURE, minidump `091126-19468-01.dmp` (Event 1001 at 22:33:15, Kernel-Power 41 at 22:32:59) |
| 22:33:34 | watchdog START pid 6828 — every session came back and restarted its node jobs together |
| 22:37:13 | PRESSURE 206 MB — "node x3 7725MB, claude x23 3655MB" |
| 22:37:57 | trim from **43 MB** available |
| 22:40:54 | PRESSURE 1,107 MB — the last watchdog line before crash 2 |
| 22:47:45 | GPU engine timeout, LiveKernelEvent 0x141 |
| **crash 2** | bugcheck **0x116** VIDEO_TDR_FAILURE, argument `0xffffffffc000009a` (STATUS_INSUFFICIENT_RESOURCES), minidump `091126-28640-01.dmp`; Event 1019 names `nvlddmkm.sys` (Event 1001 at 22:51:38, Kernel-Power 41 at 22:51:11) |
| 22:53:28 | watchdog START pid 11616 |
| 23:23:42 | rule 1 KILL pid 16932, `next` start-server.js at 8.00 GB |
| 23:24:01–23:24:11 | the gate's first refusals (below) |
| 23:27:04 | rule 7 live test on a dummy process: killed pid 23096 (37 MB), OK |
| 23:27:07 | rule 7 live test, dry run on the real box: would kill pid 18852, 3,938 MB RAM, 4.11 GB commit |
| 23:28:46 | watchdog START pid 4076, `critRamMB=500` — rule 7 live |

**Read the crash moment from the watchdog's last line and the Event 1001 record, never from Event
6008.** Its "previous shutdown" time is the last event-log write before the crash, which reads as a
precise timestamp and is not one. The watchdog's own header rounds the two crashes to ~22:30 and
~22:50.

**Rule 7 — the critical floor.** Rules 4 and 5 can only ever reach a NEXT DEV SERVER, and both times
the memory sat in node jobs neither recognises.

| Constant | Value | Meaning |
| --- | --- | --- |
| `$CritRamMB` | 500 | available physical RAM floor |
| `$CritRamConsecutive` | 3 | polls in a row under it — a spike is not an emergency |
| `$CritKillMinGB` | 1.0 | smallest node job it will take |
| `$CritCooldownSec` | 90 | wait for the freed pages to land before judging again |

It takes ONE process per pass, `node.exe` only, the one holding the most PHYSICAL RAM because RAM is
what is missing; sessions, browsers and editors stay out of reach. It is the last move, not the
first: rules 0, 4 and 5 always act first. **Its stated cost:** the 09-11 daytime log also dipped to
187–400 MB and the box survived, so it can reclaim a job during a dip that would have passed — one
re-run, against a bluescreen costing everything open. **If it proves too eager, raise
`$CritRamConsecutive` before lowering `$CritRamMB`** — both bluescreens were preceded by MINUTES
under the floor. Proved by a 6-case self-test and the two live-test lines above.

### 2026-09-11, the same night — rules 8 and 9, written but NOT yet running

**Observed at 23:50:29 Cairo**, while this section was being written: another session added rules 8
and 9 to `mem-watchdog.ps1`. **The running watchdog is pid 4076, START 23:28:46, which predates
both** — its START line prints only `critRamMB=500`, and a new instance cannot take over while it
holds the mutex (the keepalive's probes log `EXIT - another watchdog instance holds the mutex`). The
script's header had not yet been updated to list them. So read the following as what the file says,
not as what the machine is doing; a restarted watchdog's START line printing `batchMinGB` and
`deprioMinGB` is the proof that they are live.

- **Rule 8 — concurrent heavy BATCH jobs.** Same trigger as rule 4 (under 1,800 MB for 3 polls).
  When two or more non-dev-server `node.exe` jobs each hold at least `$BatchMinGB` (1.0 GB), it keeps
  the OLDEST and reclaims the YOUNGEST, one per pass — on a start-time tie the larger — then waits
  `$BatchCooldownSec` (120 s), and stands down in any poll where an earlier rule already killed
  something. The case it closes happened at **23:24–23:28**: two sessions ran `tsc --noEmit`
  together (4.2 GB and 2.7 GB commit) at 543–613 MB available, both opened before the gate existed,
  so nothing refused them and no rule recognised them. 6-case self-test.
- **Rule 9 — deprioritize, non-destructive.** Every poll, healthy RAM included, a `node.exe` of at
  least `$DeprioMinGB` (1.0 GB) is set once to BelowNormal CPU priority and LOW memory priority. The
  reason is the second bluescreen: the graphics driver failed to recover for lack of resources, so
  batch work should lose that contest before the compositor does. It kills nothing.
- **Poll order in the file:** rule 4, then 5, then 8, then 9, then 7.

The §5 hook of that day stayed true once they ran: it listed what the watchdog reaps without claiming
the list was complete, and rule 9 reaps nothing. (§5 has been rewritten twice since — see the
2026-09-12 dev-server exemption above and the retirement below.)

### The heavy-job gate — RETIRED 2026-09-17, never to be rebuilt

🔴 **The gate and its queue no longer exist. Everything in this subsection is HISTORY — do not read
any of it as a live rule, and do not rebuild it.** The owner removed both on 2026-09-17 after being
shown the cost, measured from the gate's own log over its last 2 days 13 hours (2026-09-15 07:28 →
2026-09-17 20:44 Cairo):

| Measure | Reading |
| --- | --- |
| Wall clock spent waiting in the queue | **1,997 min — 33.3 h** |
| …of which ran NOTHING (27 give-ups) | **1,205 min — 20.1 h** |
| Longest single give-up | **16,029 s — 4 h 27 m** |
| Commands refused outright by the gate | **23**, 15 of them a plain `tsc` |

The arithmetic that made it unusable: its floor for a typecheck or build is **5,000 MB** of free
physical RAM, and this 16 GB machine habitually sits at **1–2 GB** free with a dozen Claude sessions
open (28 `claude` processes held 6.5 GB at the moment of removal, with no dev server running at all).
So the floor was effectively never met and `tsc` simply stopped being runnable — the last refusal is
stamped 20:44:37, at 2,334 MB. The per-call overhead was never the problem (measured at removal: 188 ms
median against a 129 ms bare-node baseline, ~55 ms net); **the refusals and the waiting were.**

What changed, on 2026-09-17:

- the `heavy-job-gate.mjs` entry was removed from `PreToolUse` in `~/.claude/settings.json`;
- `heavy-job-gate.mjs` and `heavy-jobs-lib.mjs` were moved to
  `~/.claude/backups/_attic-2026-09/retired-heavy-job-2026-09-17/` (kept, not deleted);
- `~/.claude/scripts/heavy-queue.mjs` became a **passthrough** — it still accepts `--max-wait-min`
  and `--heavy` so nothing that calls it breaks, but runs the command immediately and never waits;
- `memory-guard.mjs` and `session-census.mjs` stopped routing sessions at the queue.

`mem-watchdog.ps1` (the cure) and `ram-guard.ps1` are untouched and still reclaim memory under their
floors. **Prevention is now a human judgement: read live free RAM before starting a heavy job, and
prefer pushing the branch and letting CI answer (§7).**

**What replaced it, the same day.** Nothing gates a heavy job, and nothing needs to — the command the
gate was mostly refusing (`tsc`, 15 of its 23 refusals) belongs on CI anyway (§7). For dev servers
there is now `~/.claude/hooks/dev-server-reaper.mjs`, live 2026-09-17. It is not a floor and reads no
RAM: it notes the port and the exact process a session opens, and when that session ends it stops
that one process, proving ownership by an unbroken parent chain back to the session's own engine
(SessionEnd also scans for a server it never saw start). Another session's server is left alone, and
a port another open session is still using is handed to that session rather than stopped.
`node ~/.claude/hooks/dev-server-reaper.mjs status` lists what it holds, and `PHX_DEV_REAPER_OFF=1`
turns it off for one session. **It is the only thing on this machine that stops a dev server** —
`mem-watchdog.ps1` no longer does. A server you started in your own terminal is no session's child,
so that one is still yours to stop by port (§5).

The rest of this subsection records how the gate worked, for the record only.

`~/.claude/hooks/heavy-job-gate.mjs` was a user-level **PreToolUse** hook (matcher `Bash|PowerShell`,
timeout 15 s). It refused a Bash or PowerShell call that would START a dev server, typecheck, build,
lint or test run the machine could not hold. The admission rule lived in
`~/.claude/hooks/heavy-jobs-lib.mjs`, shared with the queue so the two could never disagree, and it
decided under a lock file:

1. available physical RAM is at least `MIN_AVAIL_MB` (**2,600**);
2. no other `node.exe` already holds `HEAVY_MB` (**1,200**) of private memory;
3. no other heavy job was started in the last `STAGGER_SEC` (**90 s**) — a job does not reach its
   real size at once.

A refused command was pointed at `~/.claude/scripts/heavy-queue.mjs`, which waited for a safe moment
and ran the command unchanged — up to `--max-wait-min` (default 20), then exited **75** having run
nothing. (That script still exists, as the passthrough described above: same flags, no waiting.) The
refusal text also said not to retry or re-spell the command, to stop your own idle dev server by
port, and that for typecheck, lint or tests the PR's CI is usually the better answer (§7).

- **It FAILED OPEN**, always: any error, timeout or unreadable reading allowed the command, because a
  gate that can wedge every shell call is worse than the crash. A non-heavy command returned before
  anything was spawned — measured 306 ms median against 233 ms for bare node.
- **It bound only sessions started after it was installed**, because hooks load at session start.
  The 23:24 two-typecheck case above is exactly that gap.
- **Its first refusals, 23:24 Cairo:** `pnpm run typecheck` at 1,986 MB and again at 2,215 MB with
  one heavy job running, and `next dev` at 2,853 MB — above the RAM line, refused because four heavy
  jobs were already running. No ALLOW or QUEUE line had been logged by 23:57.
- **Proof, while it ran:** a 31-case classifier self-test (`node heavy-job-gate.mjs --selftest`), and
  a live probe — **any** Bash or PowerShell command containing the probe marker named in the hook's
  header was refused, starting nothing. That included a commit message or `gh --body` argument that
  merely quoted the marker. **Nothing reads that marker now**, so the trap went with the hook.
- **The off switch (`PHX_HEAVY_GATE_OFF`) was the owner's**, not a session's.

### Keep the thresholds in step

Three tools read the same machine and must agree, or one fires where another stays silent. **Since
2026-09-17 there are two** — `heavy-jobs-lib.mjs` is retired and its column entry is struck through:

| Threshold | Where it lives |
| --- | --- |
| **2,600 MB** | `mem-watchdog.ps1` `$TrimWarnMB` · `session-census.mjs` `RAM_WARN_MB` · ~~`heavy-jobs-lib.mjs` `MIN_AVAIL_MB`~~ (retired) |
| **1,800 MB** | `mem-watchdog.ps1` `$LowRamMB` · `session-census.mjs` `RAM_FLOOR_MB` |
| **500 MB** | `mem-watchdog.ps1` `$CritRamMB` — no counterpart; nothing warns, it only reclaims |
| **1.0 GB** | `mem-watchdog.ps1` `$MultiNextMinGB` · `$CritKillMinGB` · `$BatchMinGB` · `$DeprioMinGB` |

### What the hook edit cost

Words replaced, no bullet added. `AGENTS.md` **119,072 → 119,064 bytes (−8)**; with `CLAUDE.md` at
6,332 the enforced total is **125,396 of 125,600**. The paragraph also dropped the census's
"10–12 sessions" detail (the constants table above keeps it) to pay for naming the gate.
`node scripts/memory-index-reachability.mjs` read identically before and after — **1,002 memory
files, 961 linked from an index, 41 reachable only via `AGENTS.md`, 0 reachable from neither** — and
the paragraph names no memory slug; `commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb`
is carried by [agents-memory-map.md](agents-memory-map.md) and the archive index.

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

- **`--repair` SKIPS every `.claude/worktrees/` path, and `ready()` counts a REAL `node_modules` as fine** (`--repair --nested` re-links a MISSING one, nothing else) — so a stray `pnpm install` in one is invisible to BOTH tools: `--repair` never looks, `linkModules` answers "already present" instead of replacing the directory, and `--remove` refuses the path too. Nothing reports it as a defect — the only tell is repo-doctor's file count against its siblings. Fix it BY HAND: `rmdir` the real directory, then `mklink /J` to the primary's.

- **Closing the session does NOT release its worktree, and the release is not INSTANT.** `git worktree remove` then fails *Permission denied*, deregisters anyway, and leaves the husk. **No OS tool points at the holder** — a `Win32_Process` sweep, a `ParentProcessId` sweep and the Restart Manager API all report NOTHING, because a working-directory reference is not a file handle — **but `list_sessions` DOES: match the husk's path against every session's `cwd`.** **Quiet time frees it only once NO session is pinned there — and IDLE is not CLOSED**: `isRunning: false` means only that the session is not mid-turn, so its `cwd` reference survives and waiting stays futile until the process exits. Three husks survived 330s of untouched quiet; a retry 20 minutes later, after one holder went idle, still cleared none. `git fsmonitor--daemon` — spawned by ANY `git -C <worktree>`, **your own read-only gate scans included** — outlives the session, but is NOT the mechanism: the lock held with ZERO git processes running, then cleared on the FIRST `rmdir /s /q` after 300s of **not touching the folder**. Look the holder up FIRST and close that session; a session can NEVER clear its own husk, since every command it runs resets its working directory back inside the folder. **NEVER kill git machine-wide on a loop** — `Get-Process git | Stop-Process` hits every session, and a parallel one is usually live.

- **A DEREGISTERED worktree is worse than a husk — a shell still sitting in it resolves git against the PRIMARY checkout**, silently. `git rev-parse --absolute-git-dir` returns the primary's `.git` and `git log -1` reports whatever branch IT has out, usually `main`, so a commit lands on PRODUCTION's branch with no error. **`cd` cannot escape it** — the shell RESETS its cwd back inside the husk after every command, so address the real repo with `git -C <path>`. Path-filtered reads LIE there too: `git log -- <path>` and `ls-tree | grep <path>` both came back EMPTY for a file `git show` read 127 lines from, so verify with a POSITIVE CONTROL (bytes read, fields found), never a clean-looking blank.

- **Self-removing a worktree MUTES its own session-end guard — and a `.claude/worktrees/` one canNOT retire itself at all.** `ExitWorktree` no-ops on any worktree it did not create in THAT session, and `change_directory` refuses to move a session pinned to one ("runs in an isolated worktree"), so the session's own cwd holds the folder and `git worktree remove` deregisters-then-husks every time. **So strip the payload FIRST, while you still can**: drop the junction with cmd's NON-recursive `rmdir` (never `Remove-Item -Recurse`, which can follow it into the primary), then `.next`. The husk then holds ZERO files — the only state `--fix` above will clear. Do it in the other order and the husk keeps its payload, and only quiet time and a hand `rmdir /s /q` will shift it.

- **`next dev` in a worktree needs the explicit `--webpack` flag** — TURBOPACK rejects the §5 junction, not Next; `pnpm run dev` now chooses for you (`scripts/dev-server.mjs`). **The watchdog's 6 GB kills are NOT a bundler trait** — SEVEN webpack servers died at the same ceiling. It is a watchdog-THRESHOLD problem: this server legitimately reaches ~6 GB, made acute by two servers at once. 🔴 **`--max-old-space-size` DOES bind the dev server** (corrected 2026-09-21 — the old "measured no-op" was read from a plain `node`): Next gives its server HALF OF RAM unless `NODE_OPTIONS` caps it, so start it with `node scripts/dev-server.mjs --port 3000` (4 GB cap; "The dev server's heap cap" above); `bash-guard.mjs` C7 refuses a raw `next dev`.

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

## Three §5 hooks re-measured against the machine — 2026-09-17

### The commit limit no longer floats

The section above records the pagefile as `32768/65536 MB — a range`, which is why §5 said the commit
limit FLOATS and told sessions to budget against commit. Re-read at 19:35 Cairo on 2026-09-17:
`Win32_PageFileSetting` shows `C:\pagefile.sys` at **65,536 MB initial AND maximum**, and
`AutomaticManagedPagefile` is `False`. The commit limit is therefore a fixed **79.8 GB**. At that
moment **26.3 GB** was committed while physical RAM was down to **2,193 MB free**, with 15 sessions open.
So commit headroom reads green long after RAM has gone, and RAM is the thing that runs out.

§5 now leads with FREE RAM. The thresholds themselves did not move — what stands behind them did:
later that same day the heavy-job gate and its 5,000 MB / 2,600 MB floors were retired, and since
2026-09-12 `mem-watchdog.ps1` has not touched a dev server at all. What is left is the watchdog
reclaiming a typecheck, build or test run at 1,800 MB, and any node job at 500 MB.
**Not changed:** `scripts/new-session.mjs --status` still prints only the commit charge, and its
header comment still says commit, not RAM, is what freezes the machine. Its 6 GB free-commit refusal
is still a valid guard. It is just no longer the one that bites.

### The xlsx backup is running, although it was recorded as retired

#3619 (2026-09-09, 23:52 Cairo) recorded that the owner had retired the hourly copy and its Telegram
alert, and §5 has said "NO automatic backup" since. On 2026-09-17 both scheduled tasks are **enabled
and running**:

- `Phoenix xlsx Snapshot - Hourly` last ran at 19:30 with result 0. Its log line read *"nothing new;
  all 246 sheet(s) are already in a snapshot"*.
- `Phoenix xlsx Snapshot - Failure Alert` also last ran at 19:30 with result 0.

`~/.claude/scripts/xlsx-snapshot.log` shows runs on every day from 09-09 to 09-17 (20 on 09-10 alone).
Nothing records whether he re-armed it or the retirement never reached the machine. This PR changed
nothing about the tasks. It only corrects the sentence that told sessions nothing was covered.

What it COVERS, read from `xlsx-snapshot.cmd`, `xlsx-snapshot-watch.ps1` and
`scripts/repo-doctor-xlsx-snapshot.mjs`:

- **Source:** the PRIMARY checkout's `xlsx/` (`F:\Phoenix Workforce\phoenix-workforce`). It takes
  files at the top of that folder only (`statEntries` keeps `isFile()` entries, with no recursion),
  and only untracked ones, because git already holds the tracked ones.
- **Code:** extracted from `origin/main` on every run, never the checkout's branch.
- **Destination:** `F:\PHX backup\05-data-files\xlsx-snapshot-<date>`, with each copy verified by
  SHA-256. An absent destination is refused, never created.
- **Alert:** the watch reads the task's own recorded result, so a run killed mid-flight reaches
  Telegram. So does a disabled or deleted task.

What it does NOT cover:

- **Subfolders** of `xlsx/`, and **every worktree's** `xlsx/`.
- **Hours the laptop is asleep or off.** `StartWhenAvailable` catches up on wake, and a missed run is
  never alerted, by design.
- **The disk.** C:, D:, E: and F: are partitions of ONE physical disk (Samsung PM981a NVMe, 512 GB),
  so the backup fails with the source.

`Phoenix xlsx Tripwire - At Logon` is a third task. It is not a backup: it captures the process
behind a deletion and restores TRACKED files from git.

### A live session now refreshes its lock

The lock was written once, at SessionStart, and its age was the only staleness test. So its age was
the SESSION's age: any session running past two hours (the norm here) left a lock that read
abandoned while it was still editing. A second session opening that folder was not warned.
`session-lock.mjs beat` now runs on PreToolUse for Bash, PowerShell, Edit and Write. It rewrites
`refreshedAt` at most every five minutes, and staleness is measured from that field. A beat takes
over a lock only when the lock is missing or stale, never a fresh one held by another session.

The lock was already per folder: settings.json passes `CLAUDE_PROJECT_DIR`, the session's own
worktree. That is now pinned too. `tests/session-lock-staleness-is-age.test.ts` runs the real hook
against throwaway folders.

**Outside the repository:** `~/.claude/scripts/claude-hygiene.mjs` judged a lock by `startedAt` alone.
That was the weekly `--fix` pass, the one that once deleted live locks. It was changed the same day
to read `refreshedAt` first.

## `AGENTS.md` §5 Session, worktree, and parallel-work safety — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

Before editing, run `git status`, `git branch --show-current`, `git log -1 --oneline`,
`git worktree list`. **Each line is the rule, not the evidence.** Measurements, dates and incidents
are in [docs/agents-worktree-and-machine-limits.md](agents-worktree-and-machine-limits.md).

- Use one working tree per active session. **Never two interactive sessions in one folder** — the SessionStart lock warning is a hard stop. (A crashed session's lock self-expires after 2 hours, and that AGE is the ONLY staleness test — the lock's `pid` is the hook's own parent shell, so EVERY lock names a dead PID.)
- Start new work from the latest `origin/main` on a focused `codex/<task>` branch unless told otherwise.
- Never run `git clone`, `git init`, or anything that recreates the primary repository's `.git`.
- Never discard, overwrite, clean, reset, or revert changes you did not create. Treat unexpected changes as the owner's work. If the tree is dirty, classify and preserve it.
- **Never delete a `.xlsx` or `.pdf` file**, even a stray untracked one in a worktree being cleaned up. Scan any folder for them before removing it; if found and not identical to a git-tracked copy, move them into `xlsx/` at the repo root.
- **Start a session with `node scripts/new-session.mjs <task>` — one command for the whole four-step ritual** (fetch `origin/main`, create `_wt-<task>` on `codex/<task>`, junction `node_modules`, copy the gitignored env files). It refuses below 6 GB of free commit charge. `--status` prints live headroom, `--repair` fixes a worktree missing either piece, `--from <ref>` branches elsewhere. **`git worktree add` is only step one of four** — it never copies gitignored files, so a hand-made worktree has no `.env.local` (dev-auth and the dev server then fail silently) and no `node_modules`.
- **A sibling `_wt-<task>` is a NEW project to Claude Code's own memory/settings, unlike a NESTED `.claude/worktrees/<name>` one** — the latter is Claude Code's native worktree feature and is recognized as the same project automatically; the former is just a different absolute path, so a session opened there starts with an empty auto-memory bucket and no `.claude/settings.local.json` (none of `MEMORY.md` or the personal Bash allow-list carries over). `scripts/sync-worktree-env.mjs` (step 4 above, and re-run at every SessionStart) now also copies `.claude/settings.local.json` from the primary when missing and points `autoMemoryDirectory` back at the primary's real memory folder — re-run it by hand (`node scripts/sync-worktree-env.mjs`) on any worktree created before this existed.
- **Never `pnpm install` inside a worktree, and never `pnpm run` — or `pnpm exec` — there.** Both run the deps-status check first, and it purges `node_modules` once it sees the lockfile has moved, destroying the junction before your command starts. **`pnpm exec` fails SILENTLY-SHAPED**: it aborts the purge (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`) and exits 1 without starting anything, while the background task reports **exit code 0** and the port stays dead — which reads as a permissions or path problem, not as pnpm. Invoke `node scripts/…` directly, and start the dev server as `node scripts/dev-server.mjs --port 3000` — it passes `--webpack` on Windows and caps the heap at 4 GB (a raw `next dev` is refused by `bash-guard.mjs` C7 since 2026-09-21). The junction is enough for `typecheck`, `lint` and `node scripts/…`, but **not for `next dev`** without the explicit `--webpack` flag (§2.1, Worktrees).
- **Stopping a dev server: kill it by PORT, not by task.** Stopping the background TASK kills the wrapper shell and leaves `next dev` itself holding 3000 — the harness reports "Successfully stopped", `curl /api/healthz` still answers 200, and the next start then fights a port it cannot have. Three times in one session, 2026-09-02. From PowerShell: `Get-NetTCPConnection -LocalPort 3000 -State Listen`, then `Stop-Process -Id <OwningProcess> -Force`. **Believe only a live probe, in both directions** — a background task can also report a bare `exit 127` moments AFTER serving a healthy 200, so read its log before blaming permissions. A curl of `000` is the only proof the port is free, and holding it stale is what breaks "one dev server at a time, ever" below.
- Prefer worktrees as siblings (`git worktree add ../_wt-<task>`). If one must live inside the repo, its folder name must start with `_wt-` (or sit under `.codex-worktrees/` or `.claude/worktrees/`) — those patterns are excluded from `tsconfig.json`, `eslint.config.mjs` and `.gitignore`; a folder matching none silently makes every local `typecheck`/`lint` several times slower. Locked worktrees under `.claude/worktrees/` belong to other live sessions — never remove them.
- **Remove worktrees with `node scripts/new-session.mjs --remove <task>`**, only after approval. It runs three gates in cost order — untracked `.xlsx`/`.pdf` rescue scan, uncommitted work, then commits on no remote branch **and** with no merged PR — drops the junction with `cmd /c rmdir`, and re-reads the folder's branch live rather than trusting an earlier scan. That last gate asks the merged PR, never reachability — **a squash-merged branch legitimately holds commits `main` does not.**
- **`git worktree remove` leaves a HUSK, and nothing built into git can see it.** It leaves the gitignored payload — `node_modules/`, `.next/` — with no `.git` file and no registry entry, so `git worktree prune` cannot find it. **Run `pnpm run repo:doctor`** after any removal: it reports by default, and `--fix` deletes only husks proven to hold zero files.
- **A memory file with no index line is invisible, not merely hard to find.** `pnpm run repo:doctor` reports them (and pointers whose file is gone) in a MEMORY INDEX section; `--deep` lists every one. Its report never WRITES — **`--snapshot-xlsx` is the one flag in it that writes anything, and it writes only outside the repo** (next bullet) — but **read-only is not the same as local: by default it reads `.env.local` and pages the PRODUCTION GoTrue admin API** (`/auth/v1/admin/users`, `per_page=1000`, up to 50 pages) plus paged PostgREST reads, to list orphan auth users. That is the **large-page shape** §2.3's `banned_until = 'infinity'` GoTrue 500 takes, so this "local hygiene" command is the tool most exposed to it. `--no-auth` skips that leg and leaves every other section intact.
- **`xlsx/` is the one folder git cannot recover for you — `.gitignore` matches `*.xlsx`, so ~103 working spreadsheets sit in NO commit, branch or archive ref.** On 2026-09-05 an unidentified sweep deleted every **tracked** PDF there from all seven checkouts at once; those came back from git and the sheets beside them would not have — and the DR copy was 11 days stale, missing 74 of them, with nothing measuring that. 🔴 **THE HOURLY COPY AND ITS ALERT WERE RETIRED 2026-09-09 at the owner's word — these sheets have NO automatic backup.** Never tell him they are covered. `repo:doctor` still grades by CONTENT, never by name, and calls no not-knowing state clean, but prints it ONLY under `--deep`/`--snapshot-xlsx`, which copies by hand. Account: `scripts/repo-doctor-xlsx-snapshot.mjs`.
- **Worktree payload — not git, not tsc — is what makes a TREE-WALKING COMMAND slow, and only that.** Roughly 99% of the path count is worktrees, and tools honouring `.gitignore` never see it, so validation looks healthy while `grep -r` crawls. **Do not tune `tsconfig`/`eslint` — those excludes are already correct.** Cost is path COUNT, not gigabytes. 🔴 **It is NOT why the machine feels slow — corrected 2026-09-17 on a measured idle disk (99.6–99.9% idle, 0.00 queue); free RAM binds, and fewer open sessions is the lever.** Retire merged worktrees for your own command speed, never on machine-performance grounds.

**Machine limits.** RAM is soldered at 16 GB. One dev server at a time, ever; one typecheck/build at a
time locally — parallel validation belongs to CI.

**The binding limit is the Windows COMMIT charge, not RAM, and it FLOATS** — RAM plus the pagefile
*as currently allocated*. **Never budget headroom against a limit you did not just read:**
`Win32_OperatingSystem.TotalVirtualMemorySize` is the limit, `FreeVirtualMemory` the headroom, and
`node scripts/new-session.mjs --status` prints both live. **Sessions were never the ceiling** — ~0.5 GB
idle against ~3.5 GB for a dev server, build or cold typecheck, so the real limit is ~5 concurrent
HEAVY jobs.

🔴 **COMMIT headroom and PHYSICAL RAM are two ceilings; the one above stays GREEN while the machine
dies. Read FREE RAM, never the session count** — a session is ~269 MB while ONE `next dev` held
3,454 MB, more than eleven sessions. Under **2,600 MB** a dev server or cold typecheck crosses
`mem-watchdog.ps1`'s floor. 🔴 **The heavy-job gate that used to REFUSE such a job was retired on
2026-09-17 (owner instruction), and since 2026-09-12 the watchdog reaches NODE JOBS only, never a dev
server — one a session opened now dies with that session (`dev-server-reaper.mjs`).** Under
**500 MB** ANY node job, most RAM first. **Stop a dev server before closing a session, and kill it
by PORT.** `~/.claude/hooks/session-census.mjs` is deliberately SILENT until 13/16 sessions — **a
statusline count is not a guard.** Account:
[docs/agents-worktree-and-machine-limits.md](agents-worktree-and-machine-limits.md).

Route work by tier:

| Tier | Where | Use for |
| --- | --- | --- |
| **A — Cloud session** *(the default)* | Isolated cloud clone, ends in a PR | A SPECIFIED, self-contained change — feature, logic fix, refactor, a test, docs — whose context is in the repo or the prompt, plus anything heavy (build, typecheck, full test). NOT judgment calls or memory-dependent questions. Sonnet by default. |
| **B — Local worktree** (max 2–3 woken) | Sibling `_wt-<task>` | ONLY a task needing a browser look, a dev-auth role sweep, or local creds/files. |
| **C — Main checkout** (exactly one — the control tower) | primary repo folder | Decisions, merge/deploy, DB (Supabase) work, deployed-env verification, worktree triage, the memory index. Never feature edits. |

Only the control-tower session rewrites the memory index; others may append memory files but never
reorganize it.

## The routing golden rule, and why cloud feels generic (2026-09-25)

The owner audited his own local-vs-cloud habit on **2026-09-25** and confirmed the rule above as a
golden rule. This is the account behind it.

**How he actually works** (measured 2026-09-21, 90-day window): ~46 commits/day at 6.7 files each,
more fix commits (1,935) than feature (1,226), and a fifth of every instruction is
merge/deploy/verify-prod. Sessions run for hours, often after midnight, with many open at once. Two
things follow. First, most of his changes are code CI can prove — they never needed the laptop.
Second, the merge/deploy fifth is *deciding*, not building, and belongs in one place. So the rule
routes by what a task NEEDS and makes it mechanical enough to apply while tired: browser / role
sweep / local creds → local worktree; decision / merge / database → main checkout; everything else →
cloud.

**Why default-to-cloud is the anti-freeze lever, not a sacrifice.** The hard-freeze on this 16 GB box
bites on the number of concurrent *local* sessions (each ~269 MB, and one `next dev` or a cold
typecheck adds gigabytes), never on how much work exists. A cloud session runs on Anthropic's
hardware and takes nothing from this laptop's RAM, so moving the default to cloud directly removes
the pressure that causes the freeze — it is the fix, not a compromise.

**Why cloud "doesn't know the app" and answers generically** — the owner's own report on 2026-09-25,
and the reason cloud can NOT be a blanket default. A local session wakes up knowing Phoenix from
three stacked layers: (1) the git repo — `AGENTS.md`, the project `CLAUDE.md`, `docs/`, the code;
(2) the global standing rules in `~/.claude/CLAUDE.md`; (3) the auto-memory — `MEMORY.md` plus every
file under `~/.claude/projects/.../memory/`. **Only layer 1 is in git.** A cloud session is an
isolated clone of the repo, so it gets layer 1 and nothing else: layers 2 and 3 live on the laptop,
outside version control, and never travel. Verified 2026-09-25 — `git ls-files` confirms `AGENTS.md`,
the project `CLAUDE.md` and `docs/` are tracked (they reach cloud) and that no `MEMORY.md` or memory
file is tracked at all (cloud never sees them). So a cloud session's entire Phoenix knowledge is the
committed files plus whatever the task prompt spells out. Ask it an open, judgment-heavy or
memory-dependent question and it answers generically because the layer that held the answer stayed
home — that is expected, not a broken session.

**The consequence, and the discipline.** Cloud is excellent for a *specified* change whose context
lives in the repo — which is itself a reason to capture durable rules in `AGENTS.md`/`docs/` rather
than only in memory, because that is the layer cloud can read. It is wrong for a call that leans on
tribal knowledge unless the prompt carries that knowledge. Practically: a cloud task's prompt states
the facts, the files, and the exact outcome, and never assumes the session can see local state, the
standing rules, or memory.

## A browser look at pushed code goes on the Hetzner preview box, not a local dev server

A local `next dev` is the single heaviest thing that runs on this 16 GB machine — measured
2026-09-30: **4,126 MB and 3.05 of 12 cores**, sitting at `dev-server.mjs`'s own 4 GB heap cap and
GC-looping, i.e. HALF of all CPU actually in use. That one server ending took the laptop from
**626 MB free / 52% CPU to 4,782 MB / 15%**. The same server on the box costs this laptop **12 MB
and no measurable CPU** — an ssh tunnel, nothing more.

The owner starts it with `phx-preview [branch]` (`~/.claude/scripts/phx-preview.ps1`, aliased in his
PowerShell profile, `-Stop` to end it); a session ASKS HIM to run it instead of starting a local
server.

**It serves PUSHED branches only** — the box clones from GitHub and cannot see uncommitted edits, so
read `git status --porcelain` and `git rev-list --count origin/<branch>..HEAD` FIRST and say plainly
whether the preview would show the work. A local server stays right for uncommitted edits, a
dev-auth role sweep, or anything needing local files — and is stopped as soon as the look is done.

The box is 4 vCPU / 7.7 GB, idle ~97% of the day, loopback-bound behind `ufw` with only SSH open,
holding 13 Supabase/auth/Maps keys and never `SUPABASE_DB_URL`, the mailbox password, Resend,
Telegram or OpenAI.

## phx-live — the owner's dev server on the box, live edits, PRODUCTION data

**What it is for** (owner, 2026-10-12): the old `pnpm run dev` in the main folder — edit, see it
live before the merge, and use `/admin/dev-preview` (Dev Preview — Real Data) to open the system as
any real person — but with the server on the Hetzner box, because the local one costs ~4–6 GB and
stalled the laptop. `phx-preview` stays as it is: pushed branches only, staging data.

**How it runs.** `phx-live` in his PowerShell (`~/.claude/scripts/phx-live.ps1`; `-Folder`, `-Dev`,
`-DevAuth`, `-Resync`, `-Stop`, `-InstallEnv`) opens `http://localhost:3000`.

🔴 **TWO MODES SINCE 2026-10-16 — plain `phx-live` is a PRODUCTION BUILD, `phx-live -Dev` is the old
`next dev`.** See "Production-build mode" below for why: `next dev` measured 2.5–3 minutes a page on
this box. Dev-preview and `-DevAuth` work only under `-Dev` (`-DevAuth` implies it), because both
gates demand `NODE_ENV=development`.

- `phx-live-sync.mjs` watches the folder and sends each saved file over ssh as `phxlive`, whose
  forced command is `/opt/phx-live/live-receiver.mjs`. The receiver refuses any path outside the
  checkout, and anything under `.git/`, `node_modules/`, `.next/` or named `.env*`. The sync
  reconciles against a hash manifest every 60 s and does a full resync when `HEAD` moves.
- The browser reaches the server through an ssh tunnel as `phxtunnel` (`permitopen="127.0.0.1:3100"`,
  no shell). The `Host` header is `localhost`, so `/admin/dev-preview`'s loopback gate passes.
- The server runs in `phx-preview-3100.scope` as `phxlive` (no sudo). Under `-Dev` it is `next dev`,
  capped at `MemoryHigh=6800M MemoryMax=7G MemorySwapMax=5G` (raised from 5G/5632M/2G on 2026-10-16: the old cap held `-DevAuth` at 5.4 GB with its 2 GB of swap full and every first compile 10–20 s); in the default mode it is
  `/opt/phx-live/live-fast.sh`, capped at `MemoryHigh=6800M MemoryMax=7G MemorySwapMax=5G`.
  `/home/phx/live-ctl.sh` controls it (`prepare`, `serve <devauth> <fast|dev>`, `stop`, `status`,
  `install-env`, `install-env-staging`); `status` ends `mode=… build=…`. The base checkout comes from
  the read-only mirror.
- `PHX_LIVE=1` puts the red **PRODUCTION DATA — emails & notifications NOT sent** strip on every page
  (`src/components/layout/phx-live-banner.tsx`). Production and staging never set it, which
  `tests/phx-live-banner.test.ts` pins.

**The drawbacks, and how each one is handled.**

| # | Drawback | Handling |
|---|---|---|
| 1 | Unmerged code makes **real writes to production**, and production has no PITR (7 daily backups). | The same exposure as the old local `pnpm run dev`, not a new one. The red strip is on every page. No `SUPABASE_DB_URL` is on the box, so it can run no migrations and no raw SQL. |
| 2 | A notification or email started from phx-live is **lost for good**: the `notification_deliveries` row is marked `skipped`, which burns its idempotency key, so neither the production drain nor a re-run sends it. | No email, OneSignal or Telegram keys, plus `PHOENIX_EMAIL_FORCE_TESTING=true`. The strip says so. **Rule: actions that notify people (approve, publish, nudge) are done on the real site, never from phx-live.** |
| 3 | `/api/dev-auth` gives **Super Admin with no login** to any loopback request, so any process on the box would become Super Admin on production. That includes branch code as `phxci` or `phxpreview`, and the runner as `phx`. | `phx-live-firewall.service` runs `/opt/phx-live/firewall.sh`: an iptables and ip6tables `OUTPUT -o lo --dport 3100` chain that RETURNs only for uids `phxtunnel` and `phxlive` and REJECTs everyone else. |
| 4 | The **service-role key** sits on the box. A compromised box means the whole database. | The env is an allowlist, mode 600, owned by `phxlive` (no sudo). `ufw` opens SSH only. The only code that runs is his own files. If compromise is suspected, rotate the production secret key in Supabase, then update it in Railway, the GitHub secrets and the laptop `.env.local` copies. |
| 5 | The GitHub runner runs as `phx`, which has sudo. With `CI_SELF_HOSTED` on, PR code could read the env. | `phx-live` refuses to start unless `gh variable get CI_SELF_HOSTED` is `off`. Do not switch it on while the production env is on the box, unless the runner first moves to a user with no sudo. |
| 6 | Production's `PHOENIX_AUTH_SECRET` on the box would let anyone forge sessions on the real site. | The box gets its own random secret from `openssl rand`. The cost: a password-reset code made from phx-live does not work on production, so **do not do password resets from phx-live**. |
| 7 | The box has 7.7 GB. phx-live (≤7 GB in either mode) plus a preview (≤4.5 GB) plus a remote-check build (~7.4 GB) means an OOM. | Every scope is capped, and phx-live sits in its OWN `phx-live.slice` since 2026-10-16 (see "Production-build mode"). `remote-check`'s busy probe counts `phx-preview-3100.scope` as a run by its unit name (`PHX_LIVE_RUN_ID`, pinned in `tests/remote-check.test.ts` 7b), so no build starts beside it. A preview beside phx-live is absorbed by the box's 8 GB of swap, slowly. If the server is killed, the laptop side restarts it. |
| 8 | No internet, or the box is down, means no dev server at all. | Fallback: `node scripts/dev-server.mjs --port 3000` locally, as before (heavy, but it works). |
| 9 | Sync drift: `fs.watch` can miss events (a git checkout, a mass rename). | The 60 s manifest reconcile, a full resync on a `HEAD` change, and `-Resync` by hand. |
| 10 | It serves one folder at a time. | `-Folder` switches it. The start line says which folder it is syncing. |
| 11 | A lockfile change runs `pnpm install` on the box, which takes 1–2 minutes. | The window says "installing", and HMR resumes after. |
| 12 | Errors raised in phx-live land in production `app_error_events`. | The same as before. `APP_ENV=development` keeps them separable in the Error Monitor. |
| 13 | Dev-preview drops the real session (by design, `app/api/dev-auth/preview/route.ts`) and writes an audit row to production. | By design, as before. Log in again after a preview. |
| 14 | With `-DevAuth` on, any request to the port can become any role. | It is off by default. The port is firewalled (#3). The window says so when it is on. |
| 15 | A page's first compile is slow (30–60 s on the laptop). | Measured on the box 2026-10-12: `/api/healthz` answers **6 s** after `serve`, a cold `/login` through the tunnel is **1.2 s** and a warm one **0.22 s**, because `.next` survives a restart. `dev-preview` also has a replay guard for this. 🔴 **That measurement did not survive real use** — see "Production-build mode": by 2026-10-16 `next dev` here took 2.5–3 min a page. |
| 16 | In the default mode a saved edit is not on the page until the box has rebuilt (about 2 min). | The sync window prints "rebuilding" and then "✅ SERVING your latest edits — reload the page"; a failed build keeps the previous build serving and prints its error. Instant edits are `phx-live -Dev`. |

**The env.** `phx-live -InstallEnv` reads his `.env.local` and sends it on stdin to
`live-ctl.sh install-env`. That keeps only the Supabase URL, the anon, publishable and service-role
keys, the project id and ref, the Maps keys and the Google Calendar keys. It adds `APP_ENV=development`,
`PHOENIX_APP_URL=http://localhost:3000`, `PHOENIX_EMAIL_FORCE_TESTING=true`,
`PHOENIX_ENABLE_DEV_AUTH_HEADERS=false`, a random `PHOENIX_AUTH_SECRET` and `PHX_LIVE=1`, and prints
key NAMES only. Never on the box: `SUPABASE_DB_URL`, Resend, `EMAIL_NOTIFICATIONS_ENABLED`, Telegram,
OneSignal, OpenAI, the mailbox, iReports360, cron-job, Cloudflare, Action1 or the Sentry auth token.
`install-env-staging` builds the same file from the box's staging preview env, for testing.

**Idle stop.** `/home/phx/preview-idle-reaper.sh` maps port 3100 to `/home/phx/live.log`, and stops
phx-live like any preview: after 60 minutes with no request and no connection. It writes
`/home/phx/preview-state/3100.stopped`, and the laptop side then does not restart it. A built server
logs nothing per request, so in the default mode `live-fast.sh` prints "in use" every 10 minutes
while a connection is open, which keeps the log fresh.

### Production-build mode — the default since 2026-10-16 (owner: "phx live is … slow not acceptable")

**What was measured** (2026-10-16, 03:45 Cairo, `next dev`): the HR Command Center took 15.6 s, then
**2.5 min**; interview-calendar and messages calls took **2.3 min** and failed 500; memory pressure
(`/proc/pressure/memory`, full) read **75–83%**: the server was stalled waiting for memory most of the
time. 🔴 **The cap that bit was not the scope's.** `phx-preview-3100.scope` said 5.5 GB, but it ran
inside `phx-previews.slice` (`MemoryHigh=4608M MemoryMax=5G MemorySwapMax=2G`, sized for the two
phx-preview servers together), and a parent cgroup's limit wins — so `next dev`, which wants ~7 GB on
this app, had 4.5 GB and 2 GB of swap, both full. Turbopack is not the way out: it wedged on Linux
(the `sessions` module rule on `dev-server.mjs`).

**The choice.** Offered a free whole-box squeeze or a production-build mode, he chose production
build. (He will not buy a bigger box — memory note `no-hardware-purchase-for-the-ci-box`; never offer
one.)

**How it works.** `live-ctl.sh serve 0 fast` runs `/opt/phx-live/live-fast.sh` as `phxlive` in
`phx-preview-3100.scope`, in its own `phx-live.slice`, capped at `MemoryHigh=6800M MemoryMax=7G
MemorySwapMax=5G`. It runs `next build` in `/home/phxlive/live` (the synced tree), copies the source
(minus `node_modules`, `.next`, `.git`, `xlsx`, `mobile`) and the fresh `.next` into
`/home/phxlive/serve` with `node_modules` linked back, and runs `next start` there — so a rebuild
never disturbs the server answering the browser. Then it polls the tree every 2 s
(`find -newer`, skipping `next-env.d.ts`, which a build rewrites); a change waits 3 quiet seconds,
rebuilds, stops the server, copies the new `.next` in and starts it again. State is in
`/home/phxlive/live-state/fast-state` (`building`, `serving`, `serving-old`, `failed`), and
`live-ctl.sh status` ends `mode=… build=…`. `next start` prints a warning about
`output: "standalone"` and serves normally; the trade is accepted so that `node_modules` is the full
install, not standalone's traced subset.

**Measured on the first run** (03:55 Cairo): the first build took **230 s** (compiled in 3.2 min,
page data on 3 workers), peaking at **6.9 GB RAM + 2.5 GB swap**. The swap-in took ~10 s and `next
start` was ready in 131 ms. Then `/api/healthz` answered in **7 ms** on the box and `/login` in
**0.18–0.28 s** through the tunnel, against 10.0 s and 10.3 s under `next dev` an hour earlier.

**Measured on a rebuild** (04:00 Cairo, README.md touched on the box): the rebuild took **116 s**
(compile 74 s) while the old build kept serving — `/login` stayed at 10–19 ms through the build and
0.33 s at the peak of 4.1 GB swap. The swap-in then left the port **not answering for a few seconds**
(one probe read 000) while the server restarted, and `status` read `build=serving` at 04:02:00 with
`/login` at 19 ms. So a save costs about 2 minutes of waiting and a few seconds of blip, not a hang.

### Installed and proven on the box, 2026-10-12 (owner: "install phx-live on the Hetzner box")

The box-side scripts are kept on the laptop at `~/.claude/scripts/phx-live-box/`; `install.sh` there
is idempotent and is what created all of this. Measured the same evening, on staging keys:

- **The port is closed to everyone else.** `curl 127.0.0.1:3100/api/healthz` answers **200** as
  `phxlive` and as `phxtunnel`, and **000** as `phxci`, `phxpreview`, `phx` and `root`.
- **The receiver refuses every way out of the checkout** — `../escape.txt`, `.git/hooks/pre-commit`,
  `.env.local`, `node_modules/x.js` and `/etc/passwd` all come back `refused`. `ssh phxlive … id`
  prints nothing (the forced command runs instead) and `ssh phxtunnel … id` answers "This account is
  currently not available".
- **The env is only the allowlist**: 15 keys, zero matches for Resend, Telegram, OneSignal, OpenAI,
  `SUPABASE_DB_URL`, `EMAIL_NOTIFICATIONS_ENABLED`, the mailbox, iReports360, cron-job, Cloudflare,
  Action1 or the Sentry token. The `PHOENIX_AUTH_SECRET` hashes differently from the preview env's.
- **`/admin/dev-preview` answers 200** through the tunnel with dev-auth headers, and renders "Dev
  Preview — Real Data"; the same request with `Host: phoenix-hr.satopharma.com` is redirected (307),
  so the loopback gate is what opens it.
- **A saved edit reaches the box in well under a second** (1,455 ms end to end, including the ssh
  round trip of the check itself), and reverting it propagates the same way.
- **remote-check refuses to run beside it**: the probe, run as `phxci`, prints
  `RUN phx-live-dev-server 0` + `PROBE_OK`, and `decideBusyAction` returns poll → refuse, where an
  idle box returns run.
- **The cost.** Box: 1,440 MB resident, 2,484 MB peak under browsing, against the 5.5 GB cap, with
  5.7 GB still available. Laptop: **62 MB** (the sync) + **13 MB** (the tunnel) — against ~4,100 MB
  for the local dev server it replaces.

🔴 **A FINDING THAT ALSO HIT phx-preview: 15 of that day's mirror objects were group `phx`, not
`phxpreview`, so a clone from `/srv/phx-preview-mirror.git` died with "unable to open loose object …
Permission denied".** `objects/<xx>` directories git had created without the setgid bit gave their
new objects the creator's primary group, and neither `phxpreview` nor `phxlive` could read them — so
a **phx-preview of a fresh commit would have failed the same way**. Fixed on the box (`chgrp -R
phxpreview`, `chmod 2750` on every directory).

🔴 **THE GUARD LIVES IN `preview-scope.sh`'s `refresh_preview_mirror`, DIRECTLY AFTER THE FETCH THAT
CREATES THE BAD DIRECTORIES — and the copy that was in `live-ctl.sh prepare` was removed with it, so
there is exactly one.** The owner authorised the shared-file edit on 2026-10-12 ("add the
mirror-group guard to preview-scope.sh"); it had been refused before that as a shared-resource
change, which left phx-preview protected only as a side effect of somebody having run phx-live.
Sitting in `refresh_preview_mirror` covers **every** caller: `preview-start.sh` (3000),
`preview-b.sh` (3001) and `live-ctl.sh prepare` (3100). The two `find`s end in `|| true`
deliberately — each caller runs under `set -e`, and a preview that cannot be re-grouped must still
start. Proved by break-and-watch the same evening: planting the exact defect git creates (a
`drwxr-x--- phx:phx` object directory) left `phxpreview` unable to read it, `refresh_preview_mirror`
turned it into `drwxr-s--- phx:phxpreview` and readable, deleting the two lines reproduced the
failure, and restoring them fixed it again. 🔴 **Never make the mirror group-WRITABLE instead:**
`phxpreview` could then plant a `reference-transaction` hook that the next fetch would run as `phx`,
who has passwordless sudo. Pre-change backups on the box: `/home/phx/*.pre-mirror-group-guard-20261012`.

## `AGENTS.md` — the full wording condensed out on 2026-10-08

AGENTS.md loads on every request and again after every compaction, so on 2026-10-08 these lines were shortened to their rule. Nothing was dropped: each block below is the wording as it stood, word for word, and the rule it carries is still in AGENTS.md. Search here for the evidence, the owner's words and the measurements behind a rule.

### §5 — One working tree per session, and the session lock

- Use one working tree per active session. **Never two interactive sessions in one folder** — the SessionStart lock warning stops you editing that folder. 🔴 **It is no longer stop-and-ask when the holder is PROVABLY LIVE** (lock refreshed inside 15 minutes, i.e. 3 heartbeats): the hook then tells you to isolate with `node scripts/new-session.mjs <task>` and **carry on without stopping** — never ask him to confirm what the lock already proves. Measured 2026-09-21: the old single warning fired on **170 of 198** sessions here and spent a turn on that question every time. Only an OLDER non-stale lock (15 min – 2 h) may belong to a session that crashed mid-task, and that one still asks. Both halves keep every commit/push/edit ban. (A live session refreshes its lock on every Bash, PowerShell, Edit or Write call; a crashed one's self-expires 2 hours after its last refresh, and that AGE is the ONLY staleness test — the lock's `pid` is the hook's own parent shell, so EVERY lock names a dead PID.) Pinned by `tests/session-lock-staleness-is-age.test.ts` in the required `checks` job.

### §5 — The primary-write guard, pnpm in a worktree, the preview box, stopping a dev server

- **A worktree session WRITING into the primary checkout is now denied mechanically** - `.claude/hooks/primary-write-guard.mjs`, PreToolUse on Write/Edit/NotebookEdit, live 2026-09-17. It refuses an edit into the primary or another session's worktree, never a READ; before it, that write SUCCEEDED silently and stranded the change in the shared primary. **A `_wt-<task>` this session made with `new-session.mjs` is its OWN** - edit it with Edit/Write, never a Bash write. `PHX_PRIMARY_GUARD_OFF=1` stands it down; a session in the primary never sees it.
- **Never `pnpm install`, `pnpm run` or `pnpm exec` inside a worktree** — they purge the `node_modules` junction, and `pnpm exec` fails silent-shaped. Invoke `node scripts/…`; dev server: `node scripts/dev-server.mjs --port 3000` — it caps the server's heap at 4 GB where a raw `next dev` takes half of RAM, and refuses a second server; `bash-guard.mjs` C7 DENIES a raw `next dev` everywhere (2026-09-21). **Mechanical since 2026-09-16:** `bash-guard.mjs` C6 DENIES every pnpm form here and names the node equivalent — a deny because `Bash(pnpm run *)` and `Bash(pnpm exec *)` auto-approve it, so no prompt was ever coming.
- 🔴 **A BROWSER LOOK AT PUSHED CODE GOES ON THE HETZNER PREVIEW BOX, NOT A LOCAL DEV SERVER** — a local `next dev` costs ~4 GB and half the CPU (measured 2026-09-30), the box costs this laptop an ssh tunnel. The owner runs `phx-preview [branch]`; a session ASKS HIM rather than starting a local server. **It serves PUSHED branches only** — read `git status --porcelain` and `git rev-list --count origin/<branch>..HEAD` FIRST and say whether the preview would show the work; a local server stays right only for uncommitted edits, a dev-auth role sweep, or local files, and is stopped as soon as the look is done. Account: `docs/agents-worktree-and-machine-limits.md`, "A browser look at pushed code goes on the Hetzner preview box".
- **A dev server a SESSION opened dies with it** (`dev-server-reaper.mjs`, that one only); one you started yourself is nobody's child — **stop it by PORT, not by task:** `Get-NetTCPConnection -LocalPort 3000 -State Listen`, then `Stop-Process -Id <OwningProcess> -Force`. Only a curl of `000` proves the port is free. 🔴 **"NEVER CLOSE THE DEV UNTIL I TELL U" is now SCOPED, not repealed** (owner, 2026-09-28 — *"allow me to stop dev servers I start myself"*): one YOUR session started is yours to stop; one HE or another session started still waits for his word. **`TaskStop` does NOT free the memory** — it kills the wrapper and leaves the child holding the port. Check the PID's start time matches when you started it, and read free RAM TWICE: a compile spiked 3,056 MB → 134 MB and recovered to 1,675 MB by itself. `i-may-stop-a-dev-server-i-started-myself`

### §5 — Worktree payload, and the machine limits

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

### §5 — A cloud session is Phoenix-blind by default

🔴 **A CLOUD SESSION IS PHOENIX-BLIND BY DEFAULT — it gets the git repo and your prompt, and NOTHING
ELSE.** The two layers that make a LOCAL session wake up knowing Phoenix — the global standing rules
(`~/.claude/CLAUDE.md`) and the ENTIRE auto-memory (`MEMORY.md` + every memory file) — live on the
laptop, are not in git, and never reach cloud. Cloud knows only the committed files (`AGENTS.md`, the
project `CLAUDE.md`, `docs/`, the code) plus what the task prompt spells out. **So never send cloud a
judgment call or an open question that leans on tribal knowledge — send it a SPECIFIED change whose
context is in the repo or the prompt. A generic answer from cloud is this gap, not a broken session.**
Account: `docs/agents-worktree-and-machine-limits.md`.
