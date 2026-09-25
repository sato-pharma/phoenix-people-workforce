---
name: prove-it-fails-never-git-checkout-the-fix
description: "Reverting a prove-it-fails break with `git checkout -- <file>` wipes your own UNCOMMITTED fix along with the break — restore from a copy instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4a13ab2c-b77b-4e77-a1ed-2dd1db5c413b
  modified: 2026-08-03T22:43:24.682Z
---

During a prove-it-fails cycle (2026-08-04, CRM live-sync session) the break was reverted with
`git checkout -- src/lib/crm/identity.ts`. That restores the file from HEAD — and since the
session's own fix was not yet committed, it silently destroyed the fix too. The suite went red,
the owner saw the churn and concluded the session was corrupted.

**Why:** `git checkout --` cannot distinguish "the deliberate break" from "today's uncommitted
work"; it nukes both back to the last commit.

**How to apply:** for every break-then-restore cycle on uncommitted work, snapshot the file first
(`shutil.copy(p, p + ".bak")` or `cp p p.bak`) and restore by moving the backup back. Never use
`git checkout`/`git restore` on a file that carries uncommitted fix work. Alternative: commit the
fix FIRST, then break/revert freely. Related: [[prove-it-fails-verify-which-assertion-fired]].
