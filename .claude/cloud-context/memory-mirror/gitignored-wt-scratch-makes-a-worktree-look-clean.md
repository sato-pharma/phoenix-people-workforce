---
name: gitignored-wt-scratch-makes-a-worktree-look-clean
description: "`.gitignore:92 _wt-*/` hides any `_wt-scratch/` folder, so `git status` reports a worktree CLEAN while it holds irreplaceable CVs and prod-touching scripts"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8031b3ca-9a44-46e9-aef8-a95699827cf6
  modified: 2026-08-14T13:25:49.950Z
---

`.gitignore` line 92 is `_wt-*/`. That pattern matches **any** directory starting with `_wt-`
**at any depth** — including a `_wt-scratch/` folder created *inside* a worktree. So
`git status --porcelain` prints nothing and the worktree reads **clean**, while the folder holds
files that exist nowhere else and that `git worktree remove` deletes without a word.

Found 2026-08-14 retiring `_wt-scanned-pdf` (PR #2124, merged, `git status` clean, nothing
unpushed — every normal check said "safe"). `_wt-scratch/` held **26 files**:

- `Afroz Ansari CV.pdf` (343 KB) — a real candidate's CV, **confirmed to exist nowhere else on disk**
- 25 `.mts` ad-hoc scripts that had run against PRODUCTION: `apply-osama-identity`,
  `create-dsm-requisition`, `audit-remaining-rejections`, `exclude-afroz`, `retry-sara`, …

The scripts are the only record of several production changes; AGENTS bans committing temp scripts,
so git will never hold them. **Check the filesystem, never `git status`, before removing a worktree.**

```powershell
Get-ChildItem -LiteralPath $wt -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.next|\.git)\\' } |
  Where-Object { $_.Extension -match '^\.(xlsx|xls|xlsm|pdf)$' }
git -C $wt check-ignore -v "<path>"     # proves WHY it was invisible
```

Rescue **outside the repo** (`F:\Phoenix Workforce\_rescue-<name>-<date>\`), not into the repo-root
`xlsx/` folder AGENTS names: `xlsx/` is tracked here, so dropping a named person's CV there risks
committing personal data. Verify with `Get-FileHash` on both sides. See
[[never-delete-xlsx-or-pdf-files]].

**Companion hazard — happened TWICE in the same session.** (1) While this was in progress **another
live session removed `_wt-email-reduction` outright**, destroying 4 uncommitted files — two of them
untracked (a whole new page + component) existing nowhere else. A byte copy taken ~15 min earlier was
the only survivor. (2) An hour later, `_wt-cv-any-title` vanished **between two consecutive tool
calls** of my own inspection — folder emptied, registry entry gone, and the local branch
`codex/cv-extraction-any-job-title` deleted too, so `git branch -D` then errored *"branch not
found"*. Nothing was lost only because the filesystem scan had already completed.

With 5–6 sessions live, a worktree you are inspecting can disappear mid-task: **scan and back up
first, report second** — never split the scan and the rescue across turns. Related:
[[repo-doctor-no-origin-ref-is-usually-squash-residue]].
