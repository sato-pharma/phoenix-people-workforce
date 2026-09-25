---
name: hire-date-change-doubles-probation-reminders
description: "Correcting employees.hire_date re-keys every scheduled probation reminder, because notification_events.event_key embeds the DERIVED scheduled_for date - so the dedupe upsert inserts a fresh set while the stale rows stay pending, and the manager is asked to review the same person twice."
metadata:
  node_type: memory
  type: project
---

Probation reminders are scheduled off `employees.hire_date`, not off the probation case, and
`src/lib/probation/service.ts` builds each row's dedupe key as
`${hrId}:probation:${reminderType}:${scheduledFor}`, where
`scheduledFor = addDays(hireDate, 30 | 60 | 75)`.

The write is `.upsert(rows, { onConflict: "event_key", ignoreDuplicates: true })`. So when a hire
date is corrected, **every key changes**: the upsert sees no conflict, inserts a full fresh set,
and the old rows are orphaned in `pending` rather than updated. The sweep that sends them filters
only on `category = 'probation'`, `status in ('pending','scheduled')` and
`scheduled_for <= today` - so both sets fire, and the manager gets the same review request twice,
on two different dates, weeks apart.

**The durable part is the general rule: never key a dedupe on a value derived from mutable source
data.** The key cannot notice that its own input moved, so the row is orphaned instead of
corrected, and the duplicate stays invisible until the day it fires.

I caused this one myself on 2026-08-29, correcting two hire dates (AI-0009 08-20 -> 08-17,
AI-0012 08-17 -> 08-11). It left exactly 6 stale `pending` reminders, the first of which would
have fired on 16 September. Nothing surfaced it: I found it only because designing the re-anchor
trigger took me through the scheduler.

**Fixed - do not rebuild.** `trg_probation_reanchor_on_hire_date` on `public.employees`
(migration `20260829223000_probation_reanchor_on_hire_date_change.sql`, PR #2684, live in prod)
re-anchors the open case and sets any probation reminder not sitting on one of the three correct
dates to `status = 'cancelled'` - cancel, never delete, which is the house pattern in
`service.ts`. The migration's one-time cleanup took the 6 stale rows with it: `cancelled` 0 -> 6,
`pending` 44 -> 38, `sent` and `failed` unchanged.

Scope checked and contained: `service.ts` is the only place in the repo that builds an `event_key`
embedding a derived date. `in-app.ts` takes a caller-supplied `dedupeKey`, and `system.ts` uses
`eventKeyFor(input)` - neither is date-derived.

Related: [[an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing]] is the INSERT half of
the same family - a write to `employees` with a silent downstream consequence.
