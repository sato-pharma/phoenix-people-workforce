---
name: a-cairo-time-converted-by-hand-at-plus-two-is-an-hour-early
description: Egypt is on DST from late April to late October, so a Cairo time computed by hand at UTC+2 between those dates is an hour EARLY — it put "10 September 19:15 Cairo" into three source comments and the owner-rules table for an Office batch that landed 20:15, beside a publication time in the same sentence that was converted at +3 and was right; `created_at` is timestamptz, so let Postgres do it with `at time zone 'Africa/Cairo'`.
metadata:
  type: project
---

**The measurement, 2026-10-09.** `source_of_sales_import_batches.created_at` is
`timestamp with time zone`. August's `Office` batch is `2026-09-10 17:15:54.278655+00`, and
`created_at at time zone 'Africa/Cairo'` returns **2026-09-10 20:15:54** — Egypt observes DST
(reinstated 2023), so September is **UTC+3**, not +2. Three shipped source comments
(`office-distributor.ts`, `closing-office-respread.ts`, `closing-bulk-allocation.ts`) and the
measurement table in `docs/agents-owner-rules.md` said **19:15 Cairo**, an hour early, while the
publication time *in the same sentence* — 10 September 23:22 Cairo from `20:22:01+00` — had been
converted at +3 and was correct. Fixed in PR 5686.

🔴 **An inconsistent PAIR inside one sentence is the tell.** Two timestamps minutes apart in UTC
that land hours apart in the text, or two that disagree about the offset, mean one of them was typed
rather than converted. Nothing in the Office argument changed — 20:15 is still before the 23:22
publication, which is the whole point of the respread — but a wrong hour in a committed comment is
quoted back as evidence later.

**Why:** the offset is seasonal here, so a habit of "+2 for Cairo" is right from November to April
and wrong for the other half of the year, including every September and October closing.

**How to apply:** never convert by hand. In SQL use `(<col> at time zone 'Africa/Cairo')` on a
`timestamptz` and quote THAT; in node use `toLocaleString("en-GB", { timeZone: "Africa/Cairo" })`.
🔴 **Check the column type first** — `at time zone` on a `timestamp WITHOUT time zone` does the
opposite job and shifts the value the other way. `TZ=Africa/Cairo` in the MSYS shell here silently
returns UTC ([[tz-africa-cairo-silently-returns-utc-in-msys]]), and a vendor export can be Cairo
local mislabelled UTC ([[ireports360-timestamps-cairo-local-mislabeled-utc]]), so the zone is
established per source, never assumed.
