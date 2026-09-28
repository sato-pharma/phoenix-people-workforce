---
name: a-saved-plan-file-is-a-snapshot-not-a-backlog
description: "A plan replayed into a session — a ~/.claude/plans/*.md file, OR a lettered phase sequence read out of commit messages — records what was true when it was written; read git before proposing or building any item from it, because most of it has usually shipped already."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3e941c10-91bd-467d-a55c-3032b8073574
  modified: 2026-09-28T00:30:00.000Z
---

A plan file replayed into a session from `~/.claude/plans/` reads like a live backlog and is not one.
It is a point-in-time snapshot, and on this repo — ~46 commits a day — most of it has usually shipped
by the time it is replayed.

On 2026-09-23 one Phoenix CRM plan produced **four** stale proposals in a single session: the visit
form's pending pass (§A), the Team tab's per-rep count (§D), the Team tab wording (§C) and the
"Validate now" nudge on the visit confirmation (§B). All four had shipped in PR #4269 or #4281. The
fourth cost a worktree created for work that did not exist, because it went into the
`**Next step:**` line without the file being read first.

🔴 **2026-09-28 — THE SAME ERROR WITH NO PLAN FILE AT ALL, INVENTED OUT OF A LETTER SEQUENCE.** A
session with no plan in context read the head commit's own words, *"A1's last step"* (#4563), and
reasoned that A2 must therefore be next. It put **"start Phoenix CRM A2"** in the suggestion box; the
owner sent it back verbatim; **A2 had shipped two days earlier** as #4493 (`4d24f7f54`, 2026-09-26,
"the app opens on the rep's own day") — 901 lines, its own registered test
`tests/phoenix-crm-today.test.ts`, live in production. In fact **all 21 points of that plan were
merged and live** (A1–A5 · B1–B3 · C1–C3 · D1–D5 · E1–E3 · F1–F3), A1 being the deferred one that
landed LAST, which is exactly what made the letters look like a queue running forwards.

**The lettering is chronologically backwards here**, so sequence is never evidence: `A1` was built
after `F3`. And `git log --grep='phoenix-crm): D1 '` finds **nothing** for D1, D2, F1 and F2 — they
shipped inside Phase 0 under different commit subjects — so "no commit names it" does not mean "not
built" either.

**Why:** the owner is not re-reading the plan; he sends back whatever the suggestion box offers. A
stale item reaches him as a real instruction, and he spends a turn on work that is already live —
the exact loop the 2026-09-15 suggestion rules exist to close. The 09-28 case is worse than the
09-23 one: there was no stale file to blame, only an inference from a letter.

**How to apply:** before naming a plan item in a `**Next step:**` line, in a task list, or in a
worktree, `git grep` for the symbol or wording it promises to add, on `origin/main` — the primary
checkout goes stale — and `git log --grep` the label itself. **Never derive the next item from a
letter or number**: find the plan's own roster (a `search_session_transcripts` hit plus
`export_transcript` recovers it from the session that approved it) and check each point against the
tree. If it is already there, say so as your own error before anything else. Verify the database half
against `pg_proc`, never the migration ledger. See
[[verify-the-emitted-artifact-never-the-source]] and [[recommendation-goes-first-not-last]].
