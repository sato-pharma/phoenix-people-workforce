---
name: production-backup-schemas-are-all-kept
description: "His word 26 Oct 2026 ~02:25 Cairo — keep ALL the production backup schemas (about 40, e.g. sos_backup_20261012); never drop one or suggest dropping them by age."
metadata:
  node_type: memory
  type: project
  originSessionId: 967895cf-b5cb-427d-a989-2a8404633ee0
  modified: 2026-10-25T23:25:31.206Z
---

Production Supabase holds about 40 backup schemas (`sos_backup_YYYYMMDD` and siblings — pre-images of
closing, brick and price repairs). The 2026-10-26 cache audit put the question to him (keep all, or drop
those older than N days). His answer, 26 Oct 2026 ~02:25 Cairo: **"keep all the production backup schemas"**.

**Why:** production has no point-in-time recovery — seven daily backups are the whole recovery story — and
several of these schemas are the ONLY copy of a pre-repair state (see [[july-cns-office-override-and-main-store-bucket]],
[[territory-is-not-geography]]). Their size is small against the database.

**How to apply:** never drop a backup schema, never propose an age-based cleanup, and never re-raise the
question in an audit, advisor triage or storage review — answer "kept on his word, 26 Oct 2026". A NEW
backup still belongs in a non-public schema (a `public` backup table is anon-readable —
[[ad-hoc-backup-tables-are-anon-readable]]).
