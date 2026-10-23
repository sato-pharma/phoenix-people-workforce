---
name: carry-the-system-audit-ledger-exceptions
description: "#6302's two system_audit migrations are LIVE on production with no ledger row — PR #6319 carried the acknowledgement and MERGED 23 Oct 11:28 Cairo (4009a969f), so the entry is on main; never write it again."
metadata:
  node_type: memory
  type: project
  originSessionId: e00847ef-5eba-4ce7-ad71-9818ac7186de
  modified: 2026-10-23T08:16:05.356Z
---

`supabase/migrations/20261023051847_system_audit_ledger.sql` and
`20261023051848_system_audit_functions.sql` merged with **PR #6302** (23 Oct 2026, 10:41:59 Cairo,
merge `37a4b4c82`). Both are **applied on PRODUCTION** (`ozucdzovmcqvepbozvqf`) and both have
**0 rows** in `supabase_migrations.schema_migrations` — the `scripts/apply-sql-file.mjs` route, which
writes no ledger row ([[apply-sql-file-is-the-route-for-a-declined-production-data-write]]). Unlike
#6310's cache migration, whose entry **is** on `main` (`20261023091035`), **neither of these two has an
`ACKNOWLEDGED_EXCEPTIONS` entry**.

**Why it bites, and when:** `scripts/check-migrations-applied.ts` keeps a **48-hour grace window** on by
default, which is the only reason `static` passed on #6302 and still passes now. Those files are stamped
23 Oct 05:18, so from roughly **25 Oct 05:18 Cairo** the check reports them as applied-but-unrecorded and
the required `checks` job goes red on **every** open PR until an entry lands.

**The readback is already taken** (production, 23 Oct 2026, 10:43 Cairo) — positive evidence both files
ran, not object presence alone:

- the six new tables all present: `system_audit_issues`, `system_audit_issue_fixes`,
  `system_audit_occurrences`, `system_audit_status_history`, `system_audit_detector_runs`,
  `system_audit_watermarks` (a seventh, `system_audit_logs`, pre-dates them)
- 10 `system_audit_%_idx` indexes · RLS on `system_audit_issues` true
- **2** non-internal triggers on `system_audit_status_history` — the no-update and no-truncate guards of
  file 1 — and `service_role` has **neither UPDATE nor DELETE** on that table, so file 1's `revoke` ran
- all **9** functions present: file 2's `system_audit_page`, `_upsert_occurrences`,
  `_transition_status`, `_triage_occurrence`, `_acquire_lease`, `_release_lease`, `_alert_candidates`,
  `_mark_alerted`, plus file 1's `_refuse_history_change` — the 8 are what prove file 2 itself ran
- `system_audit_issues` and `system_audit_occurrences` both **0 rows**: additive DDL, no data written

**It is already written — do not write it a third time.** **PR #6319** (`codex/ack-system-audit-drift`,
worktree `_wt-ack-system-audit-drift`) carries the entry, and `codex/system-audit-drift-exception` holds
an identical duplicate commit that nothing needs; two sessions wrote the same one-file change within the
hour, which is what that tail does
([[acknowledged-exceptions-tail-conflicts-on-every-parallel-append]]). Read 23 Oct 11:14 Cairo, **#6319
is 2 files and carries ONLY this acknowledgement plus the trap write-up in
`docs/agents-session-traps-clusters.md`** — its own session reverted the `visit_lifecycle` detector fix
out of it at 11:11 Cairo (`b5a64068e`, *"drop the duplicated visit_lifecycle fix — #6325 lands it inside
roll-up #6328"*), so **never look for the detector fix in #6319**. Being 2 files it is a SMALL PR and
never goes to him alone — it belongs in a roll-up, and `node scripts/rollup-prs.mjs` groups it with the
other small ones once roll-up #6328 has merged.

**Resolved 23 Oct 2026 11:28 Cairo: #6319 merged (4009a969f); the entry is on `main`.** **How to apply:** read `ACKNOWLEDGED_EXCEPTIONS` on **`origin/main`** before writing anything, not the
checkout you are standing in; if #6319 has merged, the entry is done. Related:
[[carry-the-job-leases-drift-exception]].
