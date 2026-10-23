---
name: captureStallInSentry-is-the-web-event-loop-stall-alert
description: Sentry PHOENIX-WORKFORCE-6 / captureStallInSentry is the web process's event-loop freeze warning, and its count is a FLOOR — one event per 30 min per container; the true rate is in Railway's `event_loop_stall` WARN lines, ~4 an hour.
metadata:
  type: project
---

`PHOENIX-WORKFORCE-6`, titled `captureStallInSentry` (also `e.s.i` from the minified chunk), is one
message: **`Server froze for N s (web process) while no background job ran`** —
`stallAlertFor()` in `src/lib/observability/process-health.ts`, raised when a minute's worst
event-loop delay passes `EVENT_LOOP_STALL_ALERT_MS` (1 s) on a process that answers pages. The
worker is exempt by design. It has fired continuously since the alert was added: **168 events,
16 Oct 2026 19:24 → 23 Oct 11:18 Cairo**, every one production, every one the web role.

🔴 **The Sentry count is a FLOOR, not the rate.** `STALL_SENTRY_REPEAT_AFTER_MS` is 30 minutes and
`lastSentryAt` is per PROCESS, so one container reports at most twice an hour and a container that
lives ten minutes may report once. Read the truth from Railway:
`railway logs <deployment-id> -s phoenix-people-workforce -e production -d --lines 5000 | grep event_loop_stall`
— every freeze logs its own WARN line with `stallMs`, `sinceLastStallS`, `uptimeS`, `heapUsedMb`,
`rssMb`. Measured on the 22 Oct container (bd835566, alive 15 h): **51 freezes in 12 h 54 m, median
gap 4 minutes** — against ~20 Sentry events for the same stretch.

**Shape, measured 22–23 Oct:** 41 of 51 were 1.0–2.0 s and bursty during business hours; 10 were
4.9–5.7 s; overnight, with the container otherwise quiet, one ~5 s freeze every **~63 minutes**,
drifting a few minutes each cycle. Outliers reach 10.4 s (23 Oct 10:20), 11.5 s, **14.9 s**
(19 Oct 18:30). A fresh container freezes too — five sampled on 23 Oct each froze exactly once, at
302–1501 s of uptime, 4.8–10.4 s.

**What it is NOT.** Not memory: heap 236–909 MB against a 4288 MB V8 limit, container memory max
1.41 GB of 24 GB. Not the plan's CPU: 0.11 vCPU average, 0.58 max, limit 24. Not a background job
(none run in the web role) and not an app timer (the only `setInterval` in the web process is the
health reporter itself). Not the platform pausing containers: the worker container at the same
minutes on the same project and region never passed **113 ms** in 946 minutes. It is the web
process's own single thread, blocked.

**Leading candidate: a major V8 GC** — the frequency tracks traffic (every few minutes in the
evening, hourly when idle) and the period drifts, which is allocation-driven rather than clock-driven.
Unproven, because the alert cannot name a culprit — see
[[the-process-health-timings-and-jobs-windows-are-always-empty]]. A `PerformanceObserver` on `gc`
entries in the same line settles it in one cycle.

**Why it matters:** every request in flight waits out the freeze; Railway's own latency on the web
service reads p90 1.33 s, p95 1.59 s, p99 3.31 s over 6.3 K requests an hour. Related:
[[load-failed-is-the-reps-network-not-a-crm-fault]] (a different cause, same symptom for a rep).

**How to apply:** when a post-deploy read reports this issue as `recurring`, it is not that merge's
doing and never has been — it is the standing freeze. Say so with the log rate, never with the
Sentry count alone.
