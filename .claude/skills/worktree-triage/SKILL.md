---
name: worktree-triage
description: Run the delete-on-merge worktree cleanup ritual safely — squash-aware merged checks, an orphan sweep for `_wt-*` / `.claude/worktrees` folders git cannot see, xlsx/pdf rescue, batch owner approval. Use after PRs merge, when `git worktree list` grows past ~6 entries, or when asked to "clean worktrees".
disable-model-invocation: true
---

# Worktree Triage

Implements AGENTS.md § Parallel Work Model → Delete-on-merge ritual. Destructive
steps ALWAYS get owner approval first; everything before the approval is read-only.

## 1. Inventory (read-only)

```bash
git worktree list
```

For every worktree except the primary checkout, collect:

```bash
git -C "<worktree-path>" status --porcelain     # uncommitted/untracked work?
git -C "<worktree-path>" branch --show-current  # its branch
gh pr list --head "<branch>" --state all --json number,state,headRefOid,mergedAt
```

**Squash-aware rule:** a PR's state is the ONLY valid merged test. Never use
`git branch --merged` / ancestry — squash merges make it permanently false (this
exact bug let 24 stale worktrees accumulate).

**Newest-PR rule:** ask `--state all` and judge by the **newest** PR (highest
number), never by the first merged row. A branch gets reused after its PR merges,
so "has this branch ever had a merged PR" keeps answering yes for work that has not
merged at all — on 2026-09-03 `claude/vigorous-gould-7cdf82` read as retirable off
merged #2952 while #2965 was OPEN on the same head and a session was editing in the
folder. Retire only when the newest PR is MERGED **and** `git -C "<path>" rev-parse
HEAD` still equals that PR's `headRefOid`. Anything else keeps the worktree,
including a gh call that failed — an unanswered question is not a clean answer.
`scripts/branch-pr-state.mjs` is that rule in code, and `node scripts/repo-doctor.mjs`
prints its verdict for every worktree at once.

## 1b. Orphan sweep — directories git CANNOT see (read-only)

Everything in step 1 keys off `git worktree list`, so it structurally cannot find
folders left behind when a worktree's registration goes away but its directory does
not. `git worktree prune` misses them too. On 2026-08-01 there were **13**, quietly
accumulating since 07-27. Always run this sweep — it is not optional.

Two places to look:

```bash
find . -maxdepth 1 -type d -name '_wt-*'   # repo root
ls -1 .claude/worktrees                     # Claude Code's own worktree folder
```

A directory is an orphan when it is BOTH absent from `git worktree list` AND
resolves up into the primary checkout:

```bash
git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' > /tmp/registered.txt
grep -Fx "<abs-path>" /tmp/registered.txt   # no match => unregistered
git -C "<dir>" rev-parse --show-toplevel     # prints the PRIMARY path => orphan
```

A healthy worktree resolves to *itself*. An orphan **inside** the repo (`_wt-*` at the
repo root, or under `.claude/worktrees/`) resolves to the primary checkout — that is
the real hazard, not the disk: a session started inside one runs `git status` /
`commit` / `reset` against the **production checkout** while believing it is isolated.

A **sibling** orphan (e.g. `F:/Phoenix Workforce/_wt-foo`, outside the repo) resolves
to *nothing* — git walks up and finds no repository, so `rev-parse --show-toplevel`
returns empty. Those waste disk but cannot misdirect git, so an empty toplevel is an
orphan too, not a healthy worktree. Classify on **absence from `git worktree list`**
first; use the toplevel only to tell which of the two kinds you are holding.

**Never trust one tool to call an orphan empty.** `Get-ChildItem -Recurse` counts
dangling pnpm symlinks as entries and silently swallows MAX_PATH errors; robocopy
prints `Bytes : 0` while reporting thousands of dirs `FAILED` because it chokes on
dead links. Use `find "<dir>" -type f | wc -l` and cross-check with a second tool
before concluding anything.

`.codex-worktrees/` belongs to Codex, not Claude — leave it alone.

## 2. Classify

| Class | Criteria | Action |
| --- | --- | --- |
| REMOVE | clean tree AND merged PR (or detached HEAD with clean tree and no branch) | propose removal |
| KEEP — open work | open PR, or unpushed commits | keep, note why |
| KEEP — dirty | any uncommitted/untracked source changes | keep; NEVER remove |
| KEEP — locked | `.claude/worktrees/*` entries that are locked / belong to a live session | never touch |
| ORPHAN | unregistered AND resolves up into primary (step 1b) | rescue-scan, then plain directory removal (step 5b) — `git worktree remove` does NOT apply |

## 3. Rescue scan (before any removal)

For each REMOVE candidate, scan for `*.xlsx` / `*.pdf` anywhere in the folder.
Any found file that is not byte-identical to a git-tracked copy moves to `xlsx/`
at the primary repo root (create it if missing) BEFORE the folder is removed.
This rule has no exceptions (AGENTS.md § Session And Worktree Safety).

Orphans get the same scan. Most are empty symlink skeletons with nothing in them,
but one on 2026-08-01 held 2,095 real files — do not assume.

## 3b. Content proof — for any ORPHAN that contains real files

An orphan has no `.git`, so `git status` inside it reports the *primary's* state and
tells you nothing. Prove nothing unique would be lost by hashing every file and
testing each blob against the object database:

```bash
find "<dir>" -type f \
  -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*' \
  -not -path '*/.claude/*' -not -path '*/.turbo/*' -not -path '*/dist/*' \
  -not -path '*/coverage/*' -not -name '*.tsbuildinfo' -not -name '.eslintcache' \
  -not -name '.git' > /tmp/of.txt
git hash-object --stdin-paths < /tmp/of.txt | git cat-file --batch-check > /tmp/ex.txt
awk '{print $2}' /tmp/ex.txt | sort | uniq -c    # want: all "blob", zero "missing"
```

Excluding build and local-state dirs is **required, not tidiness**. `.next/`,
`.eslintcache`, `.claude/session.lock` and `settings.local.json` are gitignored, so
they are legitimately absent from git and will each report `missing` — on one real
worktree that was 235 false alarms out of 300 files. Do NOT try to filter with
`git check-ignore` instead: `.claude/` is itself gitignored, so for any orphan under
`.claude/worktrees/` it marks *every* file ignored and the filter collapses.

Every `missing` blob is content that exists nowhere in git history. Map those back
by **line number**, never by grepping for the word:

```bash
awk 'NR==FNR{s[FNR]=$2; next} s[FNR]=="missing"{print $0}' /tmp/ex.txt /tmp/of.txt
```

`grep 'missing'` also matches filenames like `missing-punch-verification.tsx` and
overstated the result ~7x when this was first run. Before calling two files
different, normalize line endings first (`tr -d '\r'`) — this repo is CRLF
throughout, and raw `diff` will otherwise report every line as changed.

If survivors remain, copy them somewhere safe and show the owner the diff before
proposing removal.

## 4. One batch approval

Present the full table (worktree, branch, class, PR#, dirty-file count, rescued
files) and ask the owner once to approve the REMOVE list. Do not proceed on
silence. List ORPHAN rows separately from REMOVE rows — they are removed a
different way and carry a different risk.

## 5. Execute (only approved rows)

```bash
git worktree remove "<worktree-path>"        # never --force on first attempt
git branch -d "<branch>"                     # lowercase -d; if it refuses, STOP and report — do not -D
```

If `git worktree remove` refuses (dirty), re-classify as KEEP — dirty and report;
do not force.

**`git worktree remove` leaves a remnant. Delete it — this is where orphans come
from.** Git does not manage gitignored paths, so `node_modules/` survives removal as
a farm of dangling pnpm symlinks. The command still succeeded: it deregisters the
worktree and drops the `.git/worktrees/<name>` metadata, so from that moment the
leftover is invisible to `git worktree list` AND `git worktree prune` — it has become
an orphan (step 1b) the instant you created it. Confirmed 2026-08-01: removing
`_wt-sos-ts` left exactly **1,424 dirs / 3,263 symlinks / 0 files**, byte-for-byte the
same fingerprint as three orphans found earlier that same day. Those 13 orphans were
not anyone's mistake — they are the automatic byproduct of routine removal.

So after every `git worktree remove`, check and clean:

```bash
[ -d "<worktree-path>" ] && find "<worktree-path>" -type f | wc -l   # expect 0
```

```powershell
cmd /c "rmdir /s /q `"<abs-windows-path>`""
```

Treat a non-zero file count as a stop: something real is there, and `git worktree
remove` should not have left it. Investigate before deleting.

### 5b. Orphans (unregistered — git commands do not apply)

Re-run the guard immediately before deleting, never trusting the earlier scan: a
parallel session can register or unregister a worktree mid-triage (this happened on
2026-08-01 — `_wt-export-test2` was registered at the start of the session and an
orphan by the time it was deleted). Assert all four: unregistered, 0 files, 0
documents, and not the primary. Then:

```powershell
cmd /c "rmdir /s /q `"<abs-windows-path>`""
```

`rmdir` removes reparse points without following them; `Remove-Item -Recurse` can
traverse symlinks. Afterwards confirm the registered-worktree count is **unchanged**
— that is the proof you removed nothing real.

Exit 32 / "being used by another process" on an already-empty directory means it is
some live process's **current working directory**. Nothing is corrupt and no handle
needs breaking; it becomes deletable when that session exits. Do NOT kill processes
to force it.

Finish with `git worktree list` + a summary of removed/kept/rescued, and re-run the
step 1b sweep to confirm zero orphans remain.
