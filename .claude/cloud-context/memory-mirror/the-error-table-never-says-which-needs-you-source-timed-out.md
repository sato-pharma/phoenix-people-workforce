---
name: the-error-table-never-says-which-needs-you-source-timed-out
description: "app_error_events keeps labels.event (as `route`) and DROPS every other structured label — so a `needs_you_source_timeout` row has blank hr_id, role and stack and never names the source; read notification_events.metadata (the delivered digest) instead."
metadata:
  node_type: memory
  type: project
  originSessionId: 154ed2c1-c999-4e0b-8f74-060c2887ab9e
  modified: 2026-10-23T06:10:47.037Z
---

`src/lib/needs-you/service.ts` logs a timeout with `labels: { event, source: adapter.id, hrId, role, scope }`, but the row that reaches `public.app_error_events` on production carries only `route = 'needs_you_source_timeout'` — `labels.event` mapped onto `route` — with `hr_id`, `role` and `stack` all NULL and **nothing anywhere holding `source`**. Measured 23 Oct 2026 on `ozucdzovmcqvepbozvqf`.

So "which Needs You source failed?" cannot be answered from the error table at all, and a count of those rows undercounts the sources lost (a source whose adapter *throws* logs its own message instead — on 23 Oct, four timeout rows but five sources unread).

**The reading that does work:** `public.notification_events`, `event_key like 'needs-you-daily-digest:%'`, and `metadata->>'message'` — the digest as delivered opens with a "Could not be read" section naming every unread source in his own words. That is how the 15-morning pattern was established.

**Why:** two hours of a production investigation went into reconstructing from digests what one `select` should have answered, and the first instinct — counting error rows — would have given the wrong number of lost sources.

**How to apply:** investigating any Needs You or board-source failure, go to `notification_events.metadata` first and treat `app_error_events` as a timestamp index only. Before using a structured label in any Phoenix error-table query, confirm that label actually survives the write — only `event` does. Fixing the bridge is spawned task `task_c83bdafc`. Related: [[sos-monthly-closing-is-the-only-sales-truth]].
