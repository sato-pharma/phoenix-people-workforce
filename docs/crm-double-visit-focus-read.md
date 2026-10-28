# The portal double-visit focus panel reads its people's days, not the company's year

`src/lib/double-visit-analytics/service.ts` (`getDoubleVisitPortalFocus`, `findDoubleVisitFocusDays`,
`readListedDayRuns`, `doubleVisitFocusTallies`) · pinned by
`tests/private-calendar-double-visit-days.test.ts` · module memory: `.claude/rules/crm.md`

Owner's instruction, 28 Oct 2026: **"now fix the double-visit read"**.

## What was there

The double-visit focus panel on a District Manager's and a National Sales Manager's portal landing
shows three things: the viewer's own monthly double-visit trend since January, his scope, and the
double-visit count of up to eight medical reps on probation (the ones closest to the end of
probation). To get those, it read **every double visit in the company since 1 January** — 17,535 rows,
a 7-day slice per request — on every landing, then threw away every row that did not name the viewer
or one of the eight.

## What it does now

1. **Settle the people first.** The probationers are sorted by days remaining (the same stable sort as
   before) and only the first eight are kept — they are the only counts the panel prints. With the
   viewer that is nine people at most (`DOUBLE_VISIT_FOCUS_MAX_PEOPLE`). Each hr id travels in up to
   five spellings, so nine keep the lookup's `in` lists at 45 values, inside the 50-value house limit.
2. **Find their days.** `findDoubleVisitFocusDays` is the private calendar's day lookup
   (`findDoubleVisitCalendarDays`, the shared core `findDoubleVisitDays`) with no cap on days: the
   days in the window on which any of the nine is a participant, by hr id and by every CRM id a saved
   mapping points at them.
3. **Read only those whole days, a week per request.** `readListedDayRuns` cuts the day list into runs
   of at most 7 days (`dayScanRuns`, `DOUBLE_VISIT_SLICE_DAYS`), reads four runs at a time, each bounded
   by its own first and last day, and puts the rows back in id order (`compareUuidText`) — the order
   the whole-window read returns and the order chain visits are resolved in. A day list travels in
   the URL, and past a few hundred values PostgREST answers an empty set with no error, so one request
   never carries more than its own run.
4. **Same panel.** Every figure the panel prints comes from a row naming one of the nine, or from the
   rest of that row's day (a chain visit), so whole days give every printed figure exactly what the
   whole-window read gives it. A tenth person — another rep's count — may be partial and is never shown.
   Nobody to show → no read at all. A lookup that fails → the whole window, as before (log event
   `portal_focus_double_visit_days_failed`).

## What it costs — measured on production, 28 Oct 2026

Read-only SELECTs only (no temporary objects, no `EXPLAIN ANALYZE`), each returning the same columns
and measured with `pg_stat_statements` as shared buffers touched:

| Read | Buffers | Change |
| --- | ---: | ---: |
| Old: every 7-day slice from 1 Jan to 28 Oct (43 slices) | 163,189 | — |
| New: a District Manager with no probationer (49 days, one lookup page) | 58,331 | about 64% less |
| New: the median nine-person set (131 days, two lookup pages) | about 136,100 | about 17% less |
| New: the busiest nine-person set (179 days) | about 158,900 | about 3% less |

The nine-person sets are a pessimistic upper bound: eight recently active reps stood in for the
probationers, who visit far less. The plain `EXPLAIN` shows `visit_date = ANY(listed days)` as an
Index Cond on both branches of the union door, so only the listed days are read. The new read is never
worse than the old one, and the common landing — a manager with few or no probationers — reads about a
third of what it did.

## What not to "fix" back

- **Do not cap the focus lookup at 31 days** like the private calendar's: the focus window is the
  year, and the run-of-7 read takes any number of days.
- **Do not send all listed days in one request** — the URL limit returns an empty set silently.
- **Do not drop the id sort** — chain visits are resolved in the whole-window read's order.
- **Do not count the probationers before the slice** — only the eight shown are looked up, so a ninth
  probationer's count would be partial.
