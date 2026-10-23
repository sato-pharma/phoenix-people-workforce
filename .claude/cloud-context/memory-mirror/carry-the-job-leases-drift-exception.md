---
name: carry-the-job-leases-drift-exception
description: "The job_leases ACKNOWLEDGED_EXCEPTIONS entry is already on main (PR #6309) — never write it again; the three later sweep findings are PR #6312, and the two local drafts that held both were retired 23 Oct to refs/deleted-branches/codex-job-lease-widen{,2}-20261023."
metadata:
  node_type: memory
  type: project
  originSessionId: a66ce068-13da-4a94-bcfd-8b9b1a5ffee8
  modified: 2026-10-23T07:24:47.144Z
---

`supabase/migrations/20261023140000_job_leases.sql` (merged in #6297, 23 Oct 2026 09:15 Cairo) is live on
PRODUCTION (`ozucdzovmcqvepbozvqf`): `public.job_leases` present with RLS on, `public.claim_job_lease`
present, and one lease row held — so the deploy-overlap protection it exists for is working. Production has
NO ledger row for it (the ledger jumps 20261023055946 → nothing); staging carries an exact row. The MCP
declined the file, so it went through `scripts/apply-sql-file.mjs`, which writes no ledger row —
[[apply-sql-file-is-the-route-for-a-declined-production-data-write]].

**The drift exception is on `main`**, added by PR #6309 (merged 23 Oct 10:08 Cairo, `7a9f1e345`) in
`scripts/lib/migration-inventory.ts`, evidenced by digest rather than presence:
`md5(pg_proc.prosrc)` for `claim_job_lease` = `74aee73622004b3e59c564a10b1e5a70`, length 782, identical on
production and staging. **Do not write that entry again.**

**The three findings of the 23 Oct 09:50 production sweep are a SEPARATE entry, in open PR #6312**
(`codex/migration-drift-23-oct`, worktree `_wt-job-lease-widen`) — two already-applied files acknowledged
and `20261022170000_tablet_screen_recordings.sql` genuinely applied by that session.

**Why:** two local branches, `codex/job-lease-widen` and `codex/job-lease-widen2`, each carried the
job_leases entry *and* the three sweep findings in one 72-line block, drafted before #6309 merged. Both
were therefore strictly superseded, and a session reading either one would have re-proposed an entry that
is already on main. Retired 23 Oct 2026 on the owner's word, archived to
`refs/deleted-branches/codex-job-lease-widen-20261023` and `…-widen2-20261023`. The merged branch
`codex/job-lease-ledger-exception` (tip `6cc650a04`) vanished from the local refs during that same hour —
one identity on this machine, so git cannot say which session removed it; its tip stays reachable through
the widen2 archive.

**How to apply:** asked to "clear the production migration drift" or handed a fragment naming
`20261023140000_job_leases.sql`, read `ACKNOWLEDGED_EXCEPTIONS` on **`origin/main`** first — not the
checkout you are standing in. A primary that is behind makes a just-merged migration file read as missing
(`ls: cannot access …`) and the entry read as unwritten, which is how one acknowledged apply grew three
drafts. Related: [[a-cloud-mirror-drift-banner-can-be-a-stale-checkout]].
