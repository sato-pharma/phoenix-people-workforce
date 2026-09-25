---
name: worktree-payload-is-the-repo-slowness
description: "Counting traps that gave wrong answers when measuring repo bloat; the facts themselves now live in AGENTS.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: 255d2f17-55b4-428d-ad9c-882d48c775e1
  modified: 2026-08-04T17:37:52.614Z
---

**The findings themselves shipped into AGENTS.md §2 and §5 (PR #1728, 2026-08-04)** — worktree
payload is what makes the checkout slow, `git worktree remove` leaves husks `prune` cannot see, and
`pnpm run repo:doctor` ([scripts/repo-doctor.mjs](scripts/repo-doctor.mjs), PR #1727) clears them.
Read AGENTS.md for those; this file keeps only what AGENTS.md does not record.

**Three tools disagreed about the same directory, and two of them lied.** Cross-check any file count
here before believing it — each of these produced a confidently wrong number on 2026-08-04:

- **Node `Dirent.isDirectory()` is FALSE for a symlink.** The obvious `else { files++ }` scores every
  pnpm link as a file — reported 3,540 files in husks that hold zero. Use `isFile()` explicitly, and
  count links separately. This is the difference between "safe to delete" and "needs review".
- **.NET `EnumerateFiles(dir, "*", AllDirectories)` aborts silently** on the first unreadable path
  and returns a PARTIAL count with no error — returned 0 for trees holding thousands. A `catch {}`
  around it hides this completely.
- **PowerShell `Get-ChildItem -LiteralPath <dir> -Recurse -File -Include *.xlsx` silently matches
  EVERYTHING.** `-Include` needs a `\*`-suffixed path; with `-LiteralPath` on a bare directory the
  filter is ignored. It reported 4,100 "xlsx files" — the whole tree. Filter on `.Extension` instead.
  This one nearly defeated the AGENTS.md "never delete a .xlsx" check.
- Following symlinks vs not changes the answer 2.4x on the same tree (1,887,882 vs 775,903 paths),
  so always state which you measured.

**PowerShell 5.1 mangles multi-line/quoted args to native exes.** `git commit -m @'...'@` split on
embedded double quotes into dozens of bogus pathspecs; `gh api graphql -f query=$q` split into 4
args. Use `git commit -F <file>`, and use the **Bash tool** for `gh api graphql` — it handles the
quoting cleanly.

Machine context that shaped the fix: [[laptop-m17r2-ram-soldered-16gb-ceiling]],
[[orphaned-worktree-symlink-skeletons]], [[dont-foreground-watch-long-pipelines]].
