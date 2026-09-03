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
