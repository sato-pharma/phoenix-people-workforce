---
name: production-supabase-has-no-pitr-only-daily-backups
description: "Production Supabase has PITR OFF — recovery granularity is one whole-database daily snapshot, verified 2026-08-13."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4d615aae-6dc5-4362-b4f4-d602d9620a11
  modified: 2026-08-12T21:18:43.594Z
---

Verified 2026-08-13 via the Management API,
`GET https://api.supabase.com/v1/projects/ozucdzovmcqvepbozvqf/database/backups`
(a `SUPABASE_ACCESS_TOKEN` is already set in the shell environment — no token lives in any `.env`):

```
pitr_enabled  : FALSE
walg_enabled  : true
physical_backup_data : empty   (that field only populates when PITR is on)
daily physical backups retained : 7
org plan : pro  (Gawish / rovnkzmhokgsruftjsaw)
```

`pg_stat_archiver`: 11,309 WAL segments archived, **0 failures ever**, pushing every ~120s.

**Why this matters:** WAL archiving being healthy is *not* PITR, and it is easy to conclude
otherwise from `archive_mode=on` and a wal-g `archive_command` alone — every Supabase project has
those. Supabase only exposes restore-to-a-timestamp when the paid PITR add-on is purchased.

**How to apply:**
- On a database that pays real employees, **recovery granularity is one day and the restore unit is
  the whole database.** Say that plainly before any bulk or destructive production change.
- **Never restore a daily backup in place** — it rolls back everything since ~07:30 Cairo that day.
  The safe pattern is restore into a *new* project, extract the rows, re-insert, then pause the clone.
- 2026-08-07 had no backup at all while `failed_count` stayed 0 — if backup gaps matter, check the
  dashboard's backup log rather than trusting `pg_stat_archiver`.
- The owner has not been asked whether to buy PITR; it is an open standing question.

Related: [[marketing-xlsx-requests-were-test-data-deleted-on-purpose]]
