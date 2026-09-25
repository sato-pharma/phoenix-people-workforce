---
name: memory-reachability-classifier-reads-the-primarys-agents-md
description: "`scripts/memory-index-reachability.mjs` resolves its repo root from `git rev-parse --git-common-dir`, so run from a WORKTREE it scans the PRIMARY checkout's `AGENTS.md`, never the one you just edited. A slug you added is invisible and a slug you deleted still counts as present — so it answers `0 stranded` about a file you are not trimming, which is the exact opposite of what AGENTS.md 2.2 tells you to prove."
metadata:
  node_type: memory
  type: project
  originSessionId: 99d3c046-22e5-4747-b463-d0eac8f6116b
  modified: 2026-09-21T00:01:09.706Z
---

**The fact.** `scripts/memory-index-reachability.mjs` finds the repository it is auditing with
`git rev-parse --path-format=absolute --git-common-dir` and takes that directory's parent
(lines 285–289). In a worktree the common dir is the **PRIMARY's** `.git`, so the parent is the
**primary checkout** — and every file the classifier then reads, `AGENTS.md` included, comes from
there. The worktree you are standing in, and the `AGENTS.md` you just edited in it, are never
opened.

That resolution is deliberate and correct for the half it was written for: auto-memory is
repo-derived, one memory directory shared by every worktree, so the common dir is exactly how you
find it. The damage is that the **same** root is reused for `AGENTS.md`, where the sharing does not
hold — each worktree has its own copy.

**Measured, not inferred — 2026-09-21.** From `_wt-memory-config-audit`, a probe slug
`` `zzz-worktree-only-probe-slug` `` was appended to that worktree's `AGENTS.md` and the classifier
run immediately: **0 occurrences** in its whole output, and its header printed
`repo: F:\Phoenix Workforce\phoenix-workforce`. The probe was removed and the byte count restored.

**Why it costs a real incident.** AGENTS.md §2.2 says a relocation's condition is
*PRESENT IN THE CHECKOUT YOU TRIM FROM, not merged*, and instructs you to make
`memory-index-reachability.mjs` read **0 reachable from neither in THAT folder** before trimming.
From a worktree that instruction cannot be carried out by the tool it names. The failure is silent
and it fails in the **reassuring** direction:

- A slug you **deleted** from the worktree's `AGENTS.md` is still present in the primary's, so the
  memory it was the only pointer for reads `ok` — you trim, merge, and strand it.
- A slug you **added** there is invisible, so a memory you just made reachable reads `STRANDED` —
  and a session trusting that adds an index line it does not need, against an index with 18 bytes
  of budget left.

**How to apply.** From a worktree, do not read the classifier's verdict as being about your branch.
Either run it from the primary checkout after the change has landed there, or check by hand against
the file you actually edited — `git grep -c '`<slug>`' -- AGENTS.md` in the worktree, plus the same
grep over `MEMORY.md` in the shared memory directory. Its `0 stranded` line is a statement about
`origin/main`'s neighbourhood, not about your edit. Same shape as
[[verify-the-emitted-artifact-never-the-source]] and
[[main-is-not-the-primary-checkout]]: the tool answered truthfully about a different object than
the one in your hands.

Related: [[claude-project-dir-is-the-sessions-own-worktree]] — `CLAUDE_PROJECT_DIR` *does* follow the
session into its worktree, which is why a hook and this script can disagree about which repository
they are looking at inside one session.
