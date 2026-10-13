---
name: one-git-status-read-called-a-live-worktree-idle
description: "a single clean `git status` does NOT prove a worktree is idle — test CLEAN + QUIET (no tracked file touched for 10 minutes) + PUSHED before retiring one, and expect no session in ListAgents to claim it"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0be92338-9743-4b23-ba29-cd28bd8597f5
  modified: 2026-10-13T01:14:21.577Z
---

🔴 **A `git status --porcelain` read is a snapshot of one instant, and a retirement decision needs a
WINDOW.** On 13 Oct 2026 at ~04:08 Cairo `_wt-hr-talent-acquisition-overview` read as one dirty file;
by 04:10:19 a session had rewritten 199 lines of
`src/components/hr/talent-acquisition-calendar.tsx` and re-touched
`src/lib/hr/talent-acquisition-logic.ts`, quoting the owner's instruction of that day ("i want her
calender to show like real calender"). Between those two instants I had committed its 106 uncommitted
lines, pushed them to `refs/backups/`, and `git reset --keep`-ed the branch to its merged tip — which
took a live session's work out of its working tree mid-feature. Restored byte-identical from the
rescue commit; nothing was lost, but only because the preservation came first.

**How to apply — three conditions, never one:**

- **CLEAN** — `git status --porcelain` empty.
- **QUIET** — no tracked file's mtime inside the last ~10 minutes. This is the condition that was
  missing, and the only one that catches an agent writing through Edit/Write.
- **PUSHED** — the tip reachable from an origin ref, so removal cannot strand work.

🔴 **AND EXPECT THE OWNER OF A LIVE FOLDER TO BE UNIDENTIFIABLE.** `ListAgents` named no session that
claimed this one; the session whose title matched the branch checked its own transcript and had never
written there. `repo-doctor` can name a holding PROCESS only when a shell sits in the folder ("bash
pid 32292"), and an agent editing files with its shell elsewhere leaves only "its files were edited
0 min ago" — treat that line as a HOLDER, not a hint.

**Preserve before you touch anything**: commit the stray work and `git push origin <sha>:refs/backups/<name>`
(additive, no branch, no PR, no CI), verify with `git ls-remote origin <ref>`, and only then consider
the folder. See [[a-worktree-can-be-held-by-his-phx-live-sync]] for the other cause of a held folder.
