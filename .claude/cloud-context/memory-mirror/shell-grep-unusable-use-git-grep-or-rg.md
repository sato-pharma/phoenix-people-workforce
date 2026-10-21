---
name: shell-grep-unusable-use-git-grep-or-rg
description: "Plain `grep -r` from the repo root, `.` or node_modules never finishes (walks ~346k files for ~3.8k real ones) — use `gg`/`git grep` or `rg` there; since 2026-10-22 bash-guard C1 ADDS --exclude-dir node_modules/.git/.next/worktrees/.codex-worktrees to a read-only grep of a repo root or its .claude (~3.5 s), refuses only node_modules, worktrees, the workspace folder and drive/home/Temp roots, and passes any other named folder, file or small path untouched"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9bc3bd8d-69af-4796-a9d6-d8f9a750fcb7
  modified: 2026-10-17T19:28:33.229Z
---

Measured 2026-08-01 in `F:\Phoenix Workforce\phoenix-workforce`: **`grep -r` did not finish in
9 minutes** and had to be killed. `rg` ran the same query in **811 ms**, `git grep` in **430 ms**,
all three returning identical hits (1,481).

Cause — `grep -r` ignores `.gitignore` and walks everything:

| Path | Files |
| --- | --- |
| `.claude` (worktree `node_modules`) | 192,708 |
| `node_modules` | 128,600 |
| `.next` | 24,521 |
| **git-tracked (what you want)** | **3,775** |

~346,000 files walked to search 3,775 — 92x waste. `.claude` is the worst because Claude Code puts
its worktrees *inside* the repo and each carries its own ~94k-file `node_modules`.

**Corrected 2026-10-17:** the blanket refusal was too wide. Timed warm on this box, searching text that
is not there: `docs` 0.1 s, `scripts` 0.3 s, `supabase` 1.5 s, `app` 2.7 s, `tests` 3.7 s, `src` 4.5 s — so
the "9 ms a file" figure below no longer holds for a named folder. `bash-guard.mjs` C1 now refuses a
recursive grep only from the repo root, `.`, `..`, `node_modules`, `.claude`, an absolute path or a glob,
and allows it when every path is under src/app/tests/scripts/supabase/docs/public (`tests/bash-grep-guard.test.ts`).

**Corrected again 2026-10-22 (owner: "fix"):** the seven-folder allow-list was itself the false positive — 102 of
the 109 greps it refused over two days could not hang (`.claude/rules`, `docs/*.md`, `package.json`, the memory
folder, a scratchpad). C1 is now a deny-list: each path is resolved where it runs (cwd moved by `cd`, `~` and
variables set in the command expanded) and refused only on a big tree. Account: `docs/agents-session-traps.md`.
The same night the 7 that remained (all a repo root or its `.claude`) became a REWRITE: the hook adds the
excludes and allows the command when every segment is read-only. Never add `_wt-*` to those flags: GNU grep
applies --exclude-dir to a folder named on the command line, so a worktree root by absolute path searches nothing.

**How to apply:**
- Use `gg` (alias for `git grep -n`) for anything committed, or `rg` for untracked files too.
  `rg -uu` when you genuinely need to search ignored dirs.
- A `grep()` wrapper was added to `~/.bashrc` (with `~/.bash_profile` sourcing it; neither file
  existed before). It always passes `--exclude-dir` for `node_modules .next .git .claude .turbo
  dist coverage .pnpm-store '_wt-*' .codex-worktrees`. Verified it does **not** change behaviour for
  pipes, plain files, `-E`, `-v`, `-c`, `-i`. `grep-all` is the escape hatch to unexcluded grep.
- **Do NOT `alias grep=rg`.** ripgrep's flags collide dangerously with POSIX grep: in rg `-r` means
  `--replace` and `-E` means `--encoding`, so `grep -r pattern .` would silently treat the pattern
  as a replacement string and `grep -E 'a|b'` would fail as an unknown encoding.
- The wrapper is a **guardrail, not the fix**: even excluded down to ~6,900 files, grep still takes
  60–90 s because MSYS/Git-Bash POSIX emulation makes per-file I/O on Windows glacial (~9 ms/file).
  `gg`/`rg` remain ~100x faster. Timings on this machine swing widely with parallel-session load.

Related: [[orphaned-worktree-symlink-skeletons]], [[laptop-thrashing-pagefile-feedback-loop]]
