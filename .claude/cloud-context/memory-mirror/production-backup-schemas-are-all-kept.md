---
name: production-backup-schemas-are-all-kept
description: "RETIRED 19 Nov 2026 — his 26 Oct 'keep all the production backup schemas' is replaced by 'decide each one': every snapshot gets its own recorded decision, exported before any drop."
metadata:
  node_type: memory
  type: project
  originSessionId: 967895cf-b5cb-427d-a989-2a8404633ee0
  modified: 2026-11-19T21:40:00.000Z
---

**Retired on his word, 19 Nov 2026 ~23:35 Cairo.** Asked which rule stands (his 26 Oct "keep all the
production backup schemas" or the per-snapshot decisions he made that day), he chose **"Decide each one"**:
every snapshot schema or table gets its own recorded decision in `scripts/backup-schema-decisions.json`
(asked as a multiple-choice question when it nears 90 days), and nothing is dropped without an export first.

History: on 26 Oct 2026 ~02:25 Cairo, after the cache audit asked "keep all, or drop those older than N
days", he answered "keep all the production backup schemas". On 19 Nov he decided about 40 snapshots
"export, then drop" one group at a time and scheduled their drops (24 Nov to 8 Jan 2027).

**Why:** production has no point-in-time recovery — seven daily backups are the whole recovery story — and
several snapshots are the ONLY copy of a pre-repair state. The CSV export in
`F:\Phoenix Workforce\snapshot-exports\` (never deleted, never committed) is what makes a drop safe.

**How to apply:** never drop a backup schema or table without his recorded decision for THAT snapshot and a
verified export; never propose a blanket age-based cleanup. Process and dates:
`docs/security/backup-schema-retention.md`. A NEW backup still belongs in a non-public schema (a `public`
backup table is anon-readable — [[ad-hoc-backup-tables-are-anon-readable]]).
