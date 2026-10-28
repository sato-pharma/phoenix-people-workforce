---
name: the-afternoon-stalls-are-the-2gb-box-swapping-under-daytime-load
description: "27 Oct read: prod DB stalls/restarts track the working-day load on a 2 GB box holding a 4.3 GB database — 6.6 GB swapped out in 52 h; roster cache worked; new top loads named."
metadata:
  node_type: memory
  type: project
  originSessionId: 75744a02-5970-4531-8715-03c0ea2ebab5
  modified: 2026-10-27T17:34:19.663Z
---

Read 27 Oct 2026 ~20:30–20:45 Cairo, after the 20:22 stall that logged the two Phoenix CRM call-prep errors
(transient, nothing changed). Follows [[the-25-oct-restart-was-the-2gb-box-swapping-again]].

- Restarts 12–25 Oct: 11, every one 11:30–19:05 Cairo; none since 25 Oct 16:14. Timeout bursts still come in
  the afternoon (26 Oct 16:51, 27 Oct 20:22: a ~15 s stall, timed checkpoint started 20:22:25, no 5xx).
- Box since the 25 Oct 16:14 boot (~52 h): 1,613,189 pages swapped out (≈6.6 GB) and 926,956 in (≈3.8 GB),
  2.67 M major faults, 0 OOM kills. In the 7 quiet hours after that boot it had been ~530 MB, so the swapping happens
  in the day. Database 4.3 GB against 2.03 GB RAM (shared_buffers 512 MB); buffer hit 99.06 %.
- The roster cache (PR 6471) WORKED: `crm_contact_assignments` roster reads stuck at 2,371 since 26 Oct 00:12.
- Top daytime load now: `crm_contact_master_refresh` (every process ran its own timer and refreshed after every contact-list sync;
  415 calls, 1.1 s mean, 7.2 s max, 370k disk blocks), `phx_sales_vs_target_range` (1,158 calls, 309 ms,
  162k disk blocks), `crm_visits_unified` / `crm_plan_entries_unified` / `crm_checkins_unified` reads,
  `source_of_sales_import_rows` reads (535k + 453k disk blocks).
- `phoenix_crm_touch_trail` is the biggest table (984 MB after ~9 days, 95–180k rows a day, 11:00–18:00 peak;
  22 Oct, the four-restart day, had 178k and 37.6k in the 12:00 hour alone).
- Other sessions ran heavy manual SQL as `postgres` that evening: 19:36 a brick-in-wrong-area haversine
  cross-join, 110 s; 20:07 a customer-map × import-rows join, 42 s. See [[heavy-production-checks-wait-until-after-17-cairo]].

- His pick, ~20:50: (1) the contact-list refresh skips a tick whose inputs are unchanged (inputs stamp, migration
  `20261027174307`, applied); (2) sales-vs-target cache — NO change: `loadAchievementMonth` already caches 1 h, but
  every deploy wipes Next's file cache and there were 116 merges since 25 Oct 16:14 (median gap 8 min), so the
  1,158 calls follow the releases; (3) touch trail keeps 30 days, older days archived to the private bucket
  `phoenix-crm-touch-trail-archive` nightly 04:37 Cairo, first real delete ~2 Nov. All on branch `codex/db-load-cut`.

**Why:** a bigger compute class was the first answer — always his money decision on Supabase → Project Settings →
Compute and Disk, never chat words. The 28 Oct validation (below) made it conditional.
**How to apply:** never propose a work_mem cut; compare swap counters as a RATE since the boot.

**28 Oct 2026 validation** (docs/infrastructure/PHOENIX-FINAL-INFRASTRUCTURE-DECISION-VALIDATION.md, PR 6616): the
swapping is daytime and intermittent, but no timeline links it to the stalls or restarts; a 99 % buffer hit rate means
the data size is not the problem; the measured cost is per-request overhead (sign-in bundle 0.42 ms in SQL, 93 ms
typical and 784 ms slowest-5 % at Supabase's front door). Recommended Decision A: keep Small, cut hidden-tab polling
and duplicate reads; Medium only on a trigger (one crash restart, two stalls over 10 s in a week, or under 100 MB free
for 5 minutes on 2 working days). Restart count corrected: 9 crash restarts 11–25 Oct in Postgres's own log.

**Owner approved Decision A — 28 Oct 2026, about 01:30 Cairo** (multiple-choice answer). Re-reading the code at 01:50 to
build step 3 showed the report overstated the free request cuts: the WhatsApp inbox, sidebar badges, session pulse,
new-CV bar and recruitment overview ALREADY skip a hidden tab; the Zoom-due check and mailbox alerts MUST poll while
hidden (they open a due Zoom and send a desktop notice — never gate them); the sign-in bundle is already read once per
page render. Only the activity dashboard polled hidden — fixed in PR 6618. Folding the 11 badge reads into one needs a
database function (a migration) — his word first. So A rests on the §11 triggers, not on a request cut; the 15 %
target was withdrawn. Stage 2a (lighter CRM views) waits in `_wt-crm-read-load-cut` for his approval of one
`EXPLAIN (ANALYZE, BUFFERS)` per read shape, out of working hours.
