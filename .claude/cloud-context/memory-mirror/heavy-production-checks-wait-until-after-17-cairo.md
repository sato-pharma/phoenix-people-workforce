---
name: heavy-production-checks-wait-until-after-17-cairo
description: "owner 2026-10-19 — a multi-second analytical query, parity view or temp-view check run on PRODUCTION through the management API waits until after 17:00 Cairo (or before 09:00); on 19 Oct 15:19–15:27 Cairo the app's every Supabase call timed out in three waves while such checks ran."
metadata:
  node_type: memory
  type: feedback
  originSessionId: a6ff0797-0a15-4dba-9437-79dbc60306c8
  modified: 2026-10-19T13:30:01.942Z
---

A heavy check on the PRODUCTION database — an analytical query, a parity view, a `create temp view … ` over the visit and check-in history, anything that runs more than a second or two — runs **after 17:00 Cairo (or before 09:00), never in working hours.** Applying a migration is not the thing this rule is about; the multi-second reads that prove it are.

**Why:** 19 Oct 2026, 15:19–15:27 Cairo, the app's Supabase calls timed out at the 15-second cap in three waves (about 1,900 at 15:20–15:21, about 1,700 at 15:24–15:26, a handful at 15:27; 3,660 on the c108e0580 release across 90 kinds of call, 380 on the release before it at 15:19:15). The row that failed to persist in `app_error_events` (route `app_error_insert_failed`, 15:21:18 and 15:21:44) was a casualty: 12 of 14 insert attempts timed out like everything else, so it was not the error table and not #6144. Supabase's gateway logs show tiny reads (regions list, product list) taking 14–15 s at the front door while `pg_stat_statements` puts the same queries at 0.1 ms mean and 15 ms worst — the wait was before the database, not inside a query; by 15:24:30 the same reads were back to 74–100 ms. The waves line up with the Phoenix CRM entry-days speed-up checks another session ran straight on production (temp views built at 15:17 three times and 15:20:26, parity counts of 4.1 s, 5.7 s and 12.4 s, the migration at 15:26:57). That timing FITS but is not proven — no database CPU history is readable from here, and the 15:24–15:26 wave has no logged statement beside it. A `statement:` line in `postgres_logs` is logged for DDL only, so the heavy count queries that follow a `create temp view` do not show.

**How to apply:** before running a long read or a parity check on production, look at the Cairo clock; inside 09:00–17:00 do the proof on staging if the shape allows it, otherwise park it until after 17:00. His choice among three (after-hours only / a 3-second statement cap / no rule) was "After 17:00 Cairo only", 2026-10-19. Not hooked: nothing refuses it mechanically, so it is a judgment each session makes. Related: [[supabase-client-15s-timeout-commits-anyway-half-applies]] (what the 15 s abort does to a write), [[disk-io-temp-spill-workmem]], and the production-only rule in AGENTS.md §8 (announce a bulk change first).
