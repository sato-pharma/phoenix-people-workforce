---
name: git-show-of-a-dotclaude-path-is-mangled-in-msys
description: "`git show origin/main:.claude/rules/<x>.md` in the MSYS shell is rewritten to `origin\\main;.claude\\rules\\...` and fails, so a loop comparing branch content to main reports EVERY line of that file as missing — do the comparison in node, never through this shell."
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-09T01:12:51.686Z
---

Retiring `_wt-portal-deductions-ledger` (9 Oct 2026, 04:0x Cairo) ran the usual condition-3 check —
every line the branch added must be on `origin/main` — as a bash loop calling
`git show origin/main:$f`. For `.claude/rules/payroll.md` the shell rewrote the argument to
`origin\main;.claude\rules\payroll.md`, git answered *"fatal: ambiguous argument"*, the captured
output was EMPTY, and the comparison therefore reported **108 of 108 lines missing from main** — a
branch that looked like it held unmerged work and must not be deleted. The same loop reported the
other ten files correctly, so nothing looked systematically broken.

Re-measured with `execFileSync` from node: the branch had added **exactly one line** to that file and
it was already on `origin/main`. Every file passed, and the retirement was safe.

**Why:** MSYS path conversion rewrites an argument that looks like a POSIX path list — a colon makes
`rev:path` read as two paths, and a leading-dot directory such as `.claude/` is exactly the shape that
triggers it. The failure is silent in a pipeline: an empty capture makes a `grep -c '^<'` count every
line as absent, which inverts the verdict instead of erroring.

**How to apply:** never read a blob through this shell with `git show <rev>:<path>` when the path
starts with a dot-directory or contains a colon. Do the whole comparison in a node script with
`execFileSync("git", [...])` (no shell), and distrust any "all N lines are missing" result — a total
miss is the signature of an empty capture, not of lost work. Related:
[[tz-africa-cairo-silently-returns-utc-in-msys]], [[verify-the-emitted-artifact-never-the-source]].
