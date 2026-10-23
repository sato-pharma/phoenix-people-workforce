---
name: carry-the-job-leases-drift-exception
description: "The job_leases ACKNOWLEDGED_EXCEPTIONS entry is in PR #6309 (codex/job-lease-ledger-exception) — never write it again; the duplicate held branch codex/db-job-leases-exception (0e19ae137) is superseded and only waits to be retired."
metadata:
  node_type: memory
  type: project
  originSessionId: e00847ef-5eba-4ce7-ad71-9818ac7186de
  modified: 2026-10-23T06:41:31.171Z
---

`supabase/migrations/20261023140000_job_leases.sql` (merged in #6297, 23 Oct 2026 09:15 Cairo) is live on
PRODUCTION (`ozucdzovmcqvepbozvqf`) and staging with `md5(pg_proc.prosrc)` for `public.claim_job_lease` =
`74aee73622004b3e59c564a10b1e5a70` on both, equal to the file's body. Production has no ledger row for it;
staging has one. A lease row `crm-live-poll` was held on production, so the protection works.

**The drift-check exception is in PR #6309** (`codex/job-lease-ledger-exception`, opened 23 Oct by the session
that applied the migration, one file: `scripts/lib/migration-inventory.ts`). Do not write the entry again.

**Superseded duplicate:** branch `codex/db-job-leases-exception` (commit `0e19ae137`, worktree
`_wt-db-job-leases-exception`, pushed, no PR) holds the same entry, written in parallel on the owner's "add the
job_leases exception to the next database PR". It is redundant and waits only for his word to retire it. Never
cherry-pick it on top of #6309 — the staleness test refuses a duplicate entry.

**Why it matters:** the daily drift check (`scripts/check-migrations-applied.ts`) reads the ledger, so until
#6309 merges it reports this file as unapplied once the 48h grace window ends (~25 Oct 09:15 Cairo). Related:
[[carry-the-15-oct-account-connector-rule-correction]].
