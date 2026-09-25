---
name: failed-git-piped-to-wc-l-reads-as-zero-dirty
description: "`git -C <dir> status --porcelain 2>/dev/null | wc -l` prints 0 when git FAILS, identical to a genuinely clean tree — it false-greened a worktree safety check before deletion. Test git's exit code, never count its output lines."
metadata:
  node_type: memory
  type: reference
  originSessionId: 55343d83-8cde-4f3d-85d4-cf526b689702
  modified: 2026-08-05T18:59:01.861Z
---

**The trap.** The idiom used everywhere to check a worktree is safe to delete —

```
git -C "$p" status --porcelain 2>/dev/null | wc -l      # "dirty count"
git -C "$p" log --oneline --not --remotes 2>/dev/null | wc -l   # "unpushed count"
```

— prints **`0` when git itself fails**, because the error goes to stderr (swallowed by `2>/dev/null`)
and stdout is empty. `0 dirty, 0 unpushed` is therefore returned for:

- a directory that does not exist,
- a worktree whose `.git` file is gone (already de-registered by another session),
- any git invocation that exits non-zero for any reason.

That is **indistinguishable from a genuinely clean, fully-pushed tree** — the exact reading the
worktree-deletion gate depends on.

**Confirmed live 2026-08-05.** During a worktree cleanup it reported `_wt-crm-scan-fanout: 0 dirty,
0 unpushed`, which was relayed to the owner as verification. The directory had in fact lost its
`.git`; every git call there returned `fatal: not a git repository`, rc=128. It hit twice in one
session — the same false zero appeared earlier for `_wt-cairo-vacancy-fns` after another session had
already removed it.

**The fix — check the exit code, not the line count:**

```
if ! git -C "$p" rev-parse --git-dir >/dev/null 2>&1; then
  echo "NOT A GIT WORKTREE — refuse to judge it clean"; exit 1
fi
d=$(git -C "$p" status --porcelain) || { echo "git failed"; exit 1; }
```

A PowerShell scan has the same shape: `& git ... ; if ($LASTEXITCODE -eq 0)` marks every file
`UNTRACKED` when git failed wholesale, which reads as "must rescue" rather than "cannot tell".

🔴 **The exit-code fix above is necessary but NOT sufficient.** It only works when git actually
fails. For a worktree nested INSIDE the main checkout (`_wt-*` in the repo folder — permitted by
AGENTS.md §5), a missing `.git` makes git walk UP and answer with the **parent repo's** branch and
dirty state. `rev-parse --git-dir` then *succeeds*, so the guard above passes while every reading
describes the wrong tree. Also assert the toplevel:
`[ "$(git -C "$p" rev-parse --show-toplevel)" = "$p" ]` —
see [[nested-worktree-without-git-impersonates-parent]] (hit live 2026-08-05).

**Why it matters here.** `scripts/repo-doctor.mjs` calls this exact failure shape out three times in
its own comments — the `--strip-idle=0` threshold, the concurrent-session guard fixed on #1727, and
the post-strip verification: *"the dangerous state is not a wrong value, it is a check that stops
being a check."* Worktrees in this repo are created and destroyed by parallel sessions mid-inspection,
so a path that was valid seconds ago routinely isn't.

Related false-green: [[typecheck-incremental-false-green]]. Related "the tool reports its own ledger,
not reality": [[list-migrations-reports-ledger-not-reality]]. See also
[[merged-pr-does-not-make-a-worktree-retirable]].
