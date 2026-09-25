---
name: staging-cannot-rehearse-shapes-only-prod-surgery-made
description: "A thorough, green staging rehearsal proves nothing about data shapes that exist only because production had manual surgery (merges, re-points, hand repairs) — enumerate read-only what the write would touch ON PROD before running it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4b74e251-a5a7-410c-b3bb-3575ede0774d
  modified: 2026-08-19T19:52:55.576Z
---

**A green staging rehearsal is evidence about the CODE, not about PRODUCTION'S DATA.** Staging only
contains the shapes someone put there. Every hand-repair, vendor merge, re-point, or one-off fix done
directly on prod creates a shape staging has never seen — and those are exactly the shapes a
"safe, idempotent" write meets first.

**The case that proved it, 2026-08-19.** The Sales→Marketing code sync was rebuilt to be safe to
re-run, rehearsed end to end on staging against a copy of the real pre-incident snapshot, run three
times, verified byte-for-byte. Genuinely green. Its retirement pass would still have **deleted 2,671
live production rows** on the first real run — `epda` 1,556 and `Ibn sina` 1,115 — because earlier
that day the owner had MERGED two vendors by re-pointing their codes onto the parent's
`distributor_id`. Staging had no merged vendors, so nothing there could express the shape. See
[[sales-to-marketing-sync-creates-ambiguous-duplicates]].

**Why:** the guard was written against "does the live source justify this row under THIS parent?" and
a merge is precisely the operation that makes the answer *no* for rows that are perfectly alive.

**How to apply:** before any bulk or destructive production write — even one whose staging rehearsal
was green, even one you believe is a no-op — **run its predicates as a read-only SELECT against
production and count exactly what it would touch.** `delete ... where X` becomes
`select count(*) ... where X` first. If the number is not what you predicted out loud, stop. This
costs one query and is the only thing that catches a defect whose trigger is data history rather
than logic.

**Ask specifically: has prod had manual surgery staging never got?** Merges, re-points, hand
deletes, backfills, `active=false` sweeps. Those rows are indistinguishable from native ones — in
this case the merge had even rewritten `raw_distributor_name` to the parent — so you cannot find
them by looking; you have to reason about what operations were performed.

Related: [[never-silent-drop-count-and-flag-instead]] (report the kept rows, never delete quietly),
[[guard-every-prod-write-when-another-session-shares-the-queue]] (put the precondition you believe
into the `WHERE`), [[migration-file-written-is-not-migration-applied]].
