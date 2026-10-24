---
name: capturestallinsentry-is-the-web-event-loop-stall-alert
description: "Sentry PHOENIX-WORKFORCE-6 / captureStallInSentry is the web process's event-loop freeze warning, and its count is a FLOOR — one event per 30 min per container; the true rate is in Railway's `event_loop_stall` WARN lines, ~4 an hour; their `gcExplainsStall` is false on every freeze measured 24 Oct: GC is ruled out; the 5 s one repeated every exactly 65:00 (the Master Map sheet's hourly check) and PR 6422 cut it to 1.4 s on a cold container (16:35, 24 Oct); the 1.0–1.5 s business-hours ones are still unattributed."
metadata:
  node_type: memory
  type: project
  originSessionId: a472bd77-2f7a-4a8f-b899-1bd96917fe75
  modified: 2026-10-24T13:41:46.598Z
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

🔴 **GARBAGE COLLECTION IS RULED OUT (24 Oct 2026, 14:50 Cairo, from the GC reading shipped in PR 6403).** One container, 24 Oct 01:30–14:25 Cairo: **23 freezes, `gcExplainsStall` false on all 23**; the longest single collection in any freeze minute was 22–87 ms against freezes of 1.0–6.5 s, and a whole minute's collections total 270–730 ms every minute, freeze or not (heap 380–990 MB of 4288). Do not propose GC tuning, `--max-old-space-size` or heap work for these freezes.

🔴 **THE 5-SECOND FREEZE IS CLOCK-DRIVEN: `sinceLastStallS` is EXACTLY 3900 s (65:00) on every overnight one** — 01:30, 02:35, 03:40, 04:45, 05:50, 06:55, 08:00, 09:05, 10:10 (5.2–6.5 s each), and it holds through the day (11:15, 12:20, 14:25 on the same grid, one 5-minute slip at 13:20), traffic or none. It is not allocation-driven, so the earlier "drifting a few minutes each cycle" was wrong. The 1.0–1.5 s freezes (10:22 onward, business hours, 12 of the 23) are a separate, traffic-shaped thing and equally not GC. **CAUSE FOUND (24 Oct 2026, same day): THE MASTER MAP SHEET'S HOURLY FULL CHECK.** At every one of the 9 grid freezes read in Railway's HTTP logs (01:29, 02:34, 03:39, 04:44, 05:49 overnight; 11:14, 12:19, 13:19, 14:24 by day) the SAME request lands in the same second: `GET /api/sales/master-map/sheet` from a Google Apps Script (user agent `Google-Apps-Script; beanserver`), taking 13.4–26.5 s end to end, while Stackdriver's `/api/healthz` probe at that second takes 3.8–5.2 s. It is the sheet's plan fetch (`?plan=1`): `google-apps-script/master-map/Code.gs` ticks every 5 minutes and runs the full check when `Date.now() - lastFull > FULL_CHECK_EVERY_MS`, so a 60-minute interval tested on 5-minute ticks fires at the 13th tick = exactly **65:00**. The plan loads the whole customer master (~74,000 rows) and `getMasterMapPlan` builds the tree and SHA-1 hashes every row (`src/lib/sales/master-map/payload.ts`) — synchronous CPU on the web process's single thread. The fix belongs in that route (yield to the loop, or do the build off the main thread), never in GC or memory settings. The 1.0–1.5 s freezes are NOT explained by this and are still unattributed.

🔴 **THE 5-SECOND FREEZE IS FIXED, MEASURED (24 Oct 2026, 16:40 Cairo) — PR 6422, merge `6590f03d1`, live 15:50 Cairo.** Two causes were in one request and both are gone. (1) The hourly plan used to reload and rebuild ~74,000 shops on every ask; `payload.ts` now fingerprints the source in slices and reuses the tree and plan when nothing changed. (2) The bigger cost of a REAL rebuild was `classifyCustomerChannel` re-folding ~58 keyword stems for every name (~0.35 ms a call, ~25 s at 74,000 shops); `customer-channel.ts` now folds each list once — 20,000 classifications 6,245 → 288 ms, 1.8 M old-vs-new answers identical. **Result on the first hourly check after the deploy (16:35, a COLD container, so the full build ran): the web thread froze 1.4 s, against 5.2–6.9 s on every one of the 14 before it.** The request itself still takes 12.5 s end to end (it is I/O and fingerprint slices that yield), and no other request in that window passed 3 s. What remains is one synchronous `buildMasterMapTree` block, once per container start or real data change — never on an unchanged hour. 🔴 **NOT YET SEEN: the SECOND check on the same container (17:40 Cairo) should cost nothing; if a later read shows a 5 s freeze on the grid again, the reuse path regressed — read `tests/master-map-plan-cache.test.ts` first.** The 1.0–1.5 s business-hours freezes are still unattributed: Saturday afternoon has too little traffic to judge, so compare against a Sunday peak, not against this note's morning count (10 in 4 h, about 2.5 an hour). The post-deploy error read said CANNOT TELL (Railway never posted the deploy's live time); read `app_error_events` by `release` instead — only a one-client "Load failed" burst on `/employee-portals/field-crm/visits` followed this deploy.

**Saturday 24 Oct 2026 peak audit (10:00–14:30 Cairo, read same day).** (1) The loop is NOT what makes pages slow at peak: at 12:00 the per-minute loop delay p99 had a median of 23.9 ms (worst minute 96.7 ms) and only 3 of 60 minutes had a >=1 s stall — yet 252 requests that hour took over 3 s. (2) Nor was the database slow today: Supabase call p50 139–267 ms (p95 up to 1.48 s at 12:00–13:00, against p50 6.1 s on 22 Oct), and no Postgres restart since 22 Oct 14:25 Cairo (`database_restarts`). So the slow pages are SEQUENCES of calls, not one slow call. (3) The 1.0–1.5 s freezes have NO common request: the minute before each (10:22, 10:26, 10:27, 10:40, 10:55, 11:23, 12:30, 12:59, 13:30, 14:18) held 170–700 requests, and the heavy ones repeat — `GET /employee-portals` (8–19 s when slow; p50 of ALL its requests is only 101 ms, so it is a long tail), `GET /admin/field-crm/validation-reviews` (8–9 s), `GET /api/sales/monthly-closing/details` (4–5 s). Unproven: that concurrent heavy server renders are what block the thread — it needs a CPU profile, not logs. (4) `POST|GET /api/auth/pulse` (the pulse PR 6400 merged on 23 Oct) is polled constantly and has p50 ~0.57 s, p95 3.7–4.6 s. (5) Slowest recurring DB statements by total time since the 22 Oct 14:25 boot: the Phoenix CRM `p_include_activity` RPC (376 calls, mean 1.7 s), `crm_visits_unified` reads, `crm_plan_entries_unified` (866 calls, mean 508 ms, max 27.8 s; a warm one-week 70-agent read costs 340 ms / 21.5k buffers), and three sales-closing RPCs averaging 3.4–7.7 s (40–78 calls each). Five 15 s Supabase timeouts today were ALL `crm_plan_entries_unified`.

**Why it matters:** every request in flight waits out the freeze; Railway's own latency on the web
service reads p90 1.33 s, p95 1.59 s, p99 3.31 s over 6.3 K requests an hour. Related:
[[load-failed-is-the-reps-network-not-a-crm-fault]] (a different cause, same symptom for a rep).

**How to apply:** when a post-deploy read reports this issue as `recurring`, it is not that merge's
doing and never has been — it is the standing freeze. Say so with the log rate, never with the
Sentry count alone.
