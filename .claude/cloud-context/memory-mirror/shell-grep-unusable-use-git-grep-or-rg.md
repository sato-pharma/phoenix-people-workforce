---
name: shell-grep-unusable-use-git-grep-or-rg
description: "Plain `grep -r` never finishes in this repo (walks ~346k files for ~3.8k real ones) — use `gg`/`git grep` or `rg`; a guard wrapper now lives in ~/.bashrc"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9bc3bd8d-69af-4796-a9d6-d8f9a750fcb7
  modified: 2026-08-01T00:53:53.384Z
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
