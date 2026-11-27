---
name: history-purge-planned-2026-11-27
description: "27 Nov 2026: owner decided to purge the filled payroll copy AND every data file no longer on main from the public GitHub history, keep local copies, delete ~455 PR-less branches, run tonight after Railway deploys again"
metadata:
  type: project
---

Owner decisions, 27 Nov 2026 ~11:30 Cairo (MCQ):
- Scope, his words: "KEEP THEM PUT ON DEVICE IN LOCAL NOT ON PUBLIC GITHUB". Purge the filled April payroll (blob `165624fab`) and the 39 data files that have left `main` (sato 4-2026/*, Outcome_VS_investment, mabretelasafra, metlife-edi-template, xlsx/ copies, backup CSVs). The 6 workbooks still on `main` stay.
- Delete the ~455 remote branches with no open PR, after a backup bundle.
- Run tonight, after Railway deploys again, at a quiet hour.

Local copies are DONE: `F:\Phoenix Workforce\GitHub History Data Files (kept 2026-11-27)\`, 39 files, hash-checked. Never delete them (protected types).
Full plan: Appendix D of `~/.claude/plans/pasted-content-id-4b53-phoenix-engineer-transient-orbit.md`.

**Why:** the repo stays public ([[the-repo-is-public-since-2026-11-07]]), so history is the only exposure left.
**How to apply:** every commit id changes after the purge. Re-seat every worktree from the new `origin/main`, and never push a branch made before the purge; it would bring the files back.
