---
name: a-saved-plan-file-is-a-snapshot-not-a-backlog
description: "A plan file replayed into a session (~/.claude/plans/*.md) records what was true when it was written; read the code before proposing or building any item from it, because most of it has usually shipped already."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3e941c10-91bd-467d-a55c-3032b8073574
  modified: 2026-09-23T06:02:12.494Z
---

A plan file replayed into a session from `~/.claude/plans/` reads like a live backlog and is not one.
It is a point-in-time snapshot, and on this repo — ~46 commits a day — most of it has usually shipped
by the time it is replayed.

On 2026-09-23 one Phoenix CRM plan produced **four** stale proposals in a single session: the visit
form's pending pass (§A), the Team tab's per-rep count (§D), the Team tab wording (§C) and the
"Validate now" nudge on the visit confirmation (§B). All four had shipped in PR #4269 or #4281. The
fourth cost a worktree created for work that did not exist, because it went into the
`**Next step:**` line without the file being read first.

**Why:** the owner is not re-reading the plan; he sends back whatever the suggestion box offers. A
stale item reaches him as a real instruction, and he spends a turn on work that is already live —
the exact loop the 2026-09-15 suggestion rules exist to close.

**How to apply:** before naming a plan item in a `**Next step:**` line, in a task list, or in a
worktree, `git grep` for the symbol or wording it promises to add, on `origin/main` — the primary
checkout goes stale. If it is already there, say so as your own error and re-read the rest of the
plan before proposing anything else from it. Verify the database half against `pg_proc`, never the
migration ledger. See [[verify-the-emitted-artifact-never-the-source]] and
[[recommendation-goes-first-not-last]].
