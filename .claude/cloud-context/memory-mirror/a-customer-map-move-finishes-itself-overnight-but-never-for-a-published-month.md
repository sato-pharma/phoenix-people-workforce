---
name: a-customer-map-move-finishes-itself-overnight-but-never-for-a-published-month
description: "A customer-map brick move does NOT reach rows already imported — but the 3:20 AM Cairo territory-restamp cron finishes it for every UNPUBLISHED period and withholds every published one whole, so the correct action after a map fix is usually to run nothing."
metadata:
  node_type: memory
  type: project
  originSessionId: 3dfa5eb2-1cfe-4ea8-b767-855d5e601f89
  modified: 2026-10-27T17:10:14.422Z
---

`source_of_sales_import_rows` carries its **own** `brick_id` / `area_code` / `region_code` stamp, and
every rollup and closing reads that stamp — not the customer map. So moving a customer in
`source_of_sales_customer_map` changes nothing a manager sees until the rows are re-stamped. 🔴 **But
the second half is already automated, and reaching for it by hand is the mistake.**

**`/api/cron/territory-restamp` runs nightly at 3:20 AM Cairo** (cron-job.org job `8350721`) and calls
`phx_sync_sos_run(periods)` over a **12-month** window (`TERRITORY_SYNC_DEFAULT_MONTHS`, max 24),
refreshing all seven rollups for every batch it moved. Its guard is in
`src/lib/sales/territory/scheduled-sync.ts`:

- **Period-granular, not (period, line)** — `phx_sync_sos_run` takes periods only, so a period with
  **ANY** line ever published is withheld **whole**.
- **No `unpublished_at is null` filter**, deliberately: a month published and later withdrawn was
  still *sent*, so it stays withheld for ever.
- **Fails CLOSED** — if it cannot read `monthly_closing_publications` it re-stamps nothing.

🔴 **UNPUBLISHING A MONTH DOES NOT RE-OPEN IT TO THE NIGHTLY RE-STAMP, AND NEITHER DOES UNLOCKING
IT.** `listPublishedClosingPeriods()` selects `monthly_closing_publications` with **no
`unpublished_at` filter**, deliberately — a month published and later withdrawn was still *sent* —
so a period stays withheld **for ever** once it has been published once. The lock table is not the
gate either: on 2026-10-12 between 00:05 and 01:07 Cairo **he unlocked all 8 closings himself and
unpublished 7 of them** (`unlocked_by`/`unpublished_by` = `b-10`, no reason recorded, leaving only
2026-07 Pedia published), and 2026-07/08/09 remain withheld regardless. 🔴 **So "he unlocked the
month" is NOT a reason to expect the night run to fix it** — only the Territory Drilldown's Sync
button reaches a once-published month, and that is his deliberate act, never a session's.

So after a map fix the honest answer is usually **"nothing to run"**. Measured 2026-10-12 across all
81 IS/IS-S codes moved that day: 130 already-imported rows carried the old stamp — **114 in never-published
periods (2026-01..06, 22,741.97 EGP) that the next 3:20 AM run corrects by itself**, and **16 in
2026-07/08 (13,106.25 EGP) withheld for ever**. Of those 16, eleven thousand of it is code 431648's own
July+August CNS rows, still credited to Qena 2 while his ruling says Qena 1 — the published-month rule
working as designed, not a defect to chase. **September was already 0 stale of 67
rows**, because the September import resolved geography from the distributor's own `Brick Name`
column — the same evidence the map move was based on — so the live month needed nothing at all.

**How to measure it** (the only honest way to say whether a map move still has work outstanding):
join `source_of_sales_import_rows` to `source_of_sales_customer_map` on **`client_code` =
`customer_code` AND `distributor_code`** — `client_code` is the customer code on import rows — and
count where `brick_id` or `area_code` differs. Then left-join `monthly_closing_locks` on
`period::text` + `lower(line)` with `unlocked_at is null` to split restampable from withheld.
`monthly_sales_period_lock` is a different, **empty** table — do not read it for this.
`monthly_closing_locks` and `monthly_closing_publications` agreed exactly on 2026-10-12: the same 8
rows (CNS+Pedia 2026-09; all three lines 2026-08 and 2026-07). **Anti Infective 2026-09 is open.**

**Why:** a session that "finishes the job" by calling `phx_sync_sos_run` by hand sweeps **every**
customer in the window, not the few it just moved, and that blast radius is the 1,070,845 EGP class of
re-split recorded in migration `20260905003000`. The nightly job is narrower in effect (it writes only
rows whose geography actually moved) and is the only path that honours the published-month rule.

**Owner, 2026-10-27 ~20:10 Cairo:** "no donot touch dates". He said it when shown the 227 out-of-date rows in the published July to September months. Never offer to correct a published month, or suggest the Sync button for one. Report the leftover rows and leave them.

**How to apply:** after a customer-map correction, **measure** the stale rows, say which periods the
night run will reach and which stay as published, and run nothing. Only a deliberate human act —
the Territory Drilldown's Sync button — corrects a published month, and that is his call, never a
session's. Related: [[moving-a-sos-brick-between-areas-needs-four-restamps]] ·
[[an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing]] ·
[[the-is-iss-twin-mismatch-is-156-and-the-distributor-answers-124]].
