---
name: the-error-table-never-says-which-needs-you-source-timed-out
description: "FIXED 23 Oct 2026 — a `needs_you_source_timeout` row now carries `source=<id> scope=<scope>` in its `stack`, so the error table finally names the source; `hr_id` and `role` are still dropped, and for which sources a digest actually lost, `notification_events.metadata` is still the only complete reading."
metadata:
  node_type: memory
  type: project
  originSessionId: 154ed2c1-c999-4e0b-8f74-060c2887ab9e
  modified: 2026-10-23T11:22:13.742Z
---

**Until release `b48a2b5a6` (23 Oct 2026, 06:36 Cairo) a `needs_you_source_timeout` row named nothing.**
`src/lib/needs-you/service.ts` logged `labels: { event, source: adapter.id, hrId, role, scope }`, and the
row that reached `public.app_error_events` on production carried only `route = 'needs_you_source_timeout'`
— `labels.event` mapped onto `route` — with `hr_id`, `role` and `stack` all NULL.

🔴 **That half is FIXED and the note's old headline is WRONG.** Measured on production the same day: every
row on `ed7797a85`, `601b6373`, `68522a1bc` and `b48a2b5a6` has `stack` NULL; the first row on release
`683f0e879` (14:18 Cairo, source `probation-decisions`, scope `company`) carries
`stack = 'source=probation-decisions scope=company'`. The spawned fix `task_c83bdafc` landed. **So "which
Needs You source timed out?" IS answerable from `app_error_events` now — read `stack`.**

**What is still true:** `hr_id` and `role` are still dropped, and a timeout row is still not a census of
the sources a digest lost — a source whose adapter *throws* logs its own message under a different event
instead (23 Oct: four timeout rows, five sources unread). For "which sources did this morning's digest
fail to read", `public.notification_events`, `event_key like 'needs-you-daily-digest:%'`,
`metadata->>'message'` remains the complete reading: the digest as delivered opens with a
"Could not be read" section naming every unread source.

**How to apply:** start at `app_error_events.stack` for the source of one timeout; go to
`notification_events.metadata` when the question is how many sources a digest lost, or when you need the
person or role. Before using any other structured label in a Phoenix error-table query, confirm it
survives the write — `event` and now this `stack` line are what do.

Related: [[sos-monthly-closing-is-the-only-sales-truth]].
