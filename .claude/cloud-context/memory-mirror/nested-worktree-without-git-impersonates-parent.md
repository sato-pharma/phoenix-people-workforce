---
name: nested-worktree-without-git-impersonates-parent
description: "A worktree nested INSIDE the main checkout that has lost its `.git` does not error — git walks up and answers with the MAIN CHECKOUT's branch, dirty state and HEAD. `rev-parse --git-dir` succeeds, so an 'is this a worktree?' guard passes. Assert `rev-parse --show-toplevel` equals the path."
metadata:
  node_type: memory
  type: reference
  originSessionId: 55343d83-8cde-4f3d-85d4-cf526b689702
  modified: 2026-08-05T18:58:39.763Z
---

**The trap.** AGENTS.md §5 permits worktrees inside the repo folder when named `_wt-*` (or under
`.claude/worktrees/`), so nested worktrees are normal here. When a parallel session removes one, the
directory can linger with **no `.git` file**. Git then does not fail — it **walks up the tree**,
finds the main checkout's `.git`, and answers every question about **the parent repo** while
appearing to describe the worktree.

```
git -C "$p" rev-parse --git-dir          -> SUCCEEDS (returns the PARENT's .git)
git -C "$p" rev-parse --abbrev-ref HEAD  -> the MAIN CHECKOUT's branch
git -C "$p" status --porcelain           -> the MAIN CHECKOUT's dirty files
```

Nothing errors. Every value is well-formed and plausible. **A guard that opens with
`git rev-parse --git-dir >/dev/null 2>&1` to reject non-worktrees passes cleanly.**

**Confirmed live 2026-08-05.** `phoenix-workforce/_wt-employee-360-duplicate` was listed RETIRABLE by
`repo:doctor`, then removed by another session seconds later. The removal guard then read branch
`codex/direct-orders-evidence-links` and "1 dirty file" — both belonging to the **main checkout**, not
the (by then non-existent) worktree. It aborted only because that branch happened to differ from the
expected one; had they matched, the guard would have authorised acting on a directory that was not a
worktree at all.

**The check that actually works — assert the toplevel is the path you asked about:**

```
top=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null)
[ "$top" = "$p" ] || { echo "ABORT: $p is not its own worktree root (resolved to $top)"; exit 1; }
```

Second tell: `git status --porcelain` printing paths that begin `../` means git's toplevel is
ABOVE the directory you asked about. A `../` in status output is a finding, not a formatting quirk.

**Scope:** this only bites worktrees nested inside the main checkout. A sibling (`F:\Phoenix
Workforce\_wt-foo`) that loses its `.git` has no parent repo to walk up into, so it fails cleanly and
[[failed-git-piped-to-wc-l-reads-as-zero-dirty]] applies instead. Exit-code checking is necessary but
**not sufficient** — it catches the sibling case and misses this one.

Related: [[failed-git-piped-to-wc-l-reads-as-zero-dirty]],
[[merged-pr-does-not-make-a-worktree-retirable]], [[parallel-session-swarm-hazard]].
