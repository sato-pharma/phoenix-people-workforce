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
