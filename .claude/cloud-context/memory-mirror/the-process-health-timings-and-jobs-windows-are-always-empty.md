---
name: the-process-health-timings-and-jobs-windows-are-always-empty
description: The process_health line's `timings` and `jobs` are empty in EVERY line on both services — the reporter drains different module instances from the ones the routes and jobs record into — so the stall fingerprint is always the same and every cause collapses into one Sentry issue.
metadata:
  type: project
---

Measured 23 Oct 2026 over 715 web lines (bd835566) and 946 worker lines (c6351168): **`timings: {}`
and `jobs: []` in every single one.** They cannot both be true — `recordTiming("supabase.fetch")` in
`src/lib/supabase/server.ts` fires on every server-side Supabase call, and `trackJob` wraps the CRM
live poller, the early-birds close and CRM housekeeping on the worker.

**Why:** `drainTimings()` / `drainJobWindow()` run in `instrumentation.ts`'s chunk
(`[root-of-the-server]__*.js`) while the recorders live in the route and job chunks, so each side
holds its **own module instance** of the `Map`. Sentry shows the split in the open: the one stall
issue carries two culprit paths, `../../../src/lib/observability/sentry-server.ts` and
`/app/.next/server/chunks/[root-of-the-server]__1vzk1b7ggbxdg._.js`.

**What it costs:** `stallAlertFor()` builds its fingerprint from the job list, so every freeze
fingerprints as `event-loop-stall | web | no background job` — **one Sentry issue for every cause,
for ever**, which is exactly why it reads as "recurring" and says nothing new. The message's "while
no background job ran" is not evidence either. See
[[captureStallInSentry-is-the-web-event-loop-stall-alert]].

**How to apply:** never read an empty `timings` or `jobs` in a `process_health` line as "the process
was idle" or "no job was running". To make the line mean something, the counters have to be shared
across chunks (a `globalThis` registry) and the stall line needs GC totals and an in-flight request
count of its own.
