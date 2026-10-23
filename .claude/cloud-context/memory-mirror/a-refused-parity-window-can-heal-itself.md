---
name: a-refused-parity-window-can-heal-itself
description: a parity window's missing_in_mirror is a point-in-time count, not a backlog — the live sync writes those visits anyway, so re-read the window before planning any repair
metadata:
  type: project
---

`ireports360_parity_windows` records what ONE sweep saw. `missing_in_mirror` is not a queue of
unwritten rows: the live sync keeps writing new visits into `ireports360_visits` between sweeps, so
a count recorded hours ago may already be zero.

Measured 2026-10-23. The `2026-09-28 → 2026-10-23` window was written `refuse` at 06:08 Cairo with
`missing_in_mirror: 8` and `extra_in_mirror: 4779`. Re-run at 12:05 the same day it came back
**`equal`** — crm 7,346 vs mirror 7,346, `repairedUpserted: 0`, `repairedDeleted: 0`. Nothing
repaired it: the 4,779 were the Phoenix-born visits the pre-[[the-january-parity-window-stays-refused]]
mirror read wrongly counted (fixed by #6313, `45967eb41`), and the 8 late saves had been written by
the ordinary live sync in the intervening six hours.

**How to force one window.** `runIReports360ParitySweep()` takes no window — it verifies whichever
is stalest by `checked_at` (`selectStalestWindow`, keyed on `window_from` only). To re-prove a
specific one, set that row's `checked_at` behind every other, then run the sweep; the run overwrites
`checked_at` itself, so the forcing edit leaves no residue. The sweep is not reachable from any
`/api/cron/*` route — it fires on the CRM live poller's own due tick, roughly every 8 hours.

**Why it matters:** planning an archive-and-repair off a stale `refuse` row spends real effort on
rows that are already correct, and a repair path that deletes is the one that cannot be undone —
production has no PITR.

**Same day, the July window.** `2026-06-30 → 2026-07-29` had stood at `repair` since 19 Oct (178
rows deleted then). Re-run at 12:08 Cairo it came back **`equal`** — 18,755 = 18,755, 0 upserted,
0 deleted, `ireports360_sync_deletions` unchanged at 593 rows. A `repair` status is the record of
an action already taken, not an open finding.

**`staleWindows` counts the forcing edit.** The sweep reports windows last checked more than
`PARITY_STALE_AFTER_DAYS` (21) ago. Backdating `checked_at` to force a window makes it stale by
that measure, so both runs reported `staleWindows: 1` — the window being verified, not a real
rotation failure. It clears as soon as the run writes its own `checked_at`.
