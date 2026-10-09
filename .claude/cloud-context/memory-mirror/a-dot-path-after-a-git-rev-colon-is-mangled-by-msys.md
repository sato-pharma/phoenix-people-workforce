---
name: a-dot-path-after-a-git-rev-colon-is-mangled-by-msys
description: In the MSYS shell here, `git rev-parse "origin/main:.claude/rules/x.md"` becomes `origin\main;.claude\rules\x.md` and git answers "not a valid object" — which reads as a MISSING FILE, so a merged-file sweep reports a file that never landed. Export MSYS_NO_PATHCONV=1.
metadata:
  type: project
---

MSYS treats a `rev:path` argument as a colon-separated PATH LIST when the part after the colon
starts with a dot, rewrites the colon to `;` and the slashes to backslashes, and git then fails with
`fatal: Not a valid object name`. Measured 2026-10-09 while retiring `_wt-leaver-charge-section`:
the three-condition check on #5656 printed `ABSENT .claude/rules/time-off.md` and refused the
retirement, while `git ls-tree origin/main .claude/rules/` listed the file perfectly.

**Why it is dangerous rather than annoying:** the failure is indistinguishable from the file not
being on `origin/main`, which is exactly the condition that must hold before a branch is deleted —
so the trap argues for *not* deleting, and a session that "fixes" it by trusting the sweep would
instead believe a landed file was lost. Only paths beginning with a dot are hit; `docs/…` and
`src/…` in the same loop compared correctly, which makes the result look selective and plausible.

**The fix:** `export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` before any git command that takes a
`<rev>:<path>`, or ask with `git ls-tree <rev> -- <path>` instead. Related: [[tz-africa-cairo-silently-returns-utc-in-msys]].
