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

## The field set stays out of this read (2 Nov 2026, "fix the portal home slow opens")

The panel counts visits and prints none, yet each request still carried `PHOENIX_VISIT_DETAIL_COLUMNS`:
one week came back at 494 KB and 317 ms with those columns, 219 KB and 246 ms without. So
`getDoubleVisitPortalFocus` passes `withoutVisitDetail: true`. Half the bytes, but only about a fifth of the
time, so the panel is still the slowest card on a manager's landing (28 requests, four at a time). It streams
under its own boundary, so the page paints without it. The next step, if the `home.card.double_visit_focus`
timer says it is worth one, is a count on the database rather than rows.

- **Do not pass `withoutVisitDetail` from anywhere else** — the report prints these columns, through this loader.

## Settled weeks come from one shared copy (3 Nov 2026, "fix the manager's double-visit panel on the home")

Tuesday 3 Nov's card timers put the panel at about 5.8 s and 28 requests in a typical minute, on Small compute.
Read from production that day: the company had 17,897 double-visit rows since January, and the typical manager had
double-visited on 62 days, in 28 different weeks, whose whole days hold about 6,200 rows. Every manager read
those rows again on every open, and most of them were the same rows.

**The owner chose the freshness** (multiple-choice answer, 3 Nov 2026): "Yes, one hour is fine". A correction to a
visit more than a week old may reach the panel up to an hour late. Everything else stays live.

`readListedDaysSharingSettledWeeks`:

- A week is settled when its Sunday is more than 7 days old. Listed days in any other week go through
  `readListedDayRuns`, live, on every open.
- A settled week is read whole, one Monday to Sunday request, into the `double-visit-settled-weeks` store for one
  hour (`SETTLED_WEEK_READ_LIMITS`). Each viewer cuts it to their own days, then the rows go back in id order.
- The identity overrides and the directory are still read on every open, and credit is decided from them, so an
  override applies at once.
- An empty week is never kept, because the door answers `[]` for a missing view. A failed read keeps nothing.
- If the day lookup fails, the panel reads the whole window live, as before.

**What it costs:** the first open after a deploy or an expired hour reads the weeks it needs, up to all of them,
four at a time. Concurrent opens share that load. The copy holds about 18,000 rows in the web process; the
budget is 40,000 and past it the oldest week goes first.

- **Do not widen the hour.** It is his word, and a longer one needs his word again.
- **Do not pass `shareSettledWeeks` from another reader.** The report, the private calendar and the scoring engine
  read this loader live.
- **Do not refresh this copy from a visit save.** A new visit is dated inside the last 7 days, which are live, and
  hundreds of saves a day would empty the copy all day.
