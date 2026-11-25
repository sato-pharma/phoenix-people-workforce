---
name: the-25-nov-cpu-pin-was-kpi-coverage-frequency-plan-scans
description: "25 Nov 2026 17:26–17:36 Cairo the 2-core production database was pinned by the KPIs Coverage and Frequency tabs — each open re-reads the WHOLE company's month of plans live (no shared copy), and ~14 reps in one room opened them together; the owner's 17:33 resize followed."
metadata:
  node_type: memory
  type: project
  originSessionId: 0d200115-5408-4367-9bdb-74b273ecfe0a
  modified: 2026-11-25T19:41:08.465Z
---

Measured 25 Nov 2026 (session 0d200115). From 17:26 to 17:36 Cairo, `crm_plan_entries_unified` took
300–900 requests a minute (baseline: one company-wide read every 10–20 min ≈ 80 day slices), 2,260 calls
and 8,878 s of database time in 17:27–17:33 alone, average 2.6 s → 6.6 s per call. The 2-core box went to
87–96% CPU; sign-in checks and visit saves timed out (117 app errors that hour). The owner resized at 17:33
([[a-database-restart-can-be-a-compute-resize]]); the burst ended by itself at 17:37.

**Who:** one network address (102.46.124.186), many devices — 13 Medical Reps from seven regions plus
District Manager Mohamed Saad, all on /employee-portals/kpis/frequency and /coverage at once (373
Frequency loads in six minutes). Looks like a group session; not proven what kind.

**Why each open is heavy:** `portal-kpi-report-page.tsx` passes `coverageDoctors` for Coverage AND
Frequency, so `getKpisBoard` skips the per-rep narrowing (`agentsRead = null`) and `getRepDoctorLists`
calls `scanPlanEntries(from, to)` company-wide. Its VISITS half has `reuseRecentWindow` (a one-minute
shared copy); the PLANS half has none — every open, even a rep looking at himself, re-reads every rep's
month of plans live.

**Also in that minute:** the "Daily Database Checks" GitHub job (scheduled 07:00, GitHub ran it 17:25)
ran `scripts/audit-backup-schemas.mjs`'s blocker query — a regex over every `pg_proc` body × every
schema — for 70.8 s (17:25:52–17:27:03). One core for a minute; a contributor, not the cause.

**How to apply:** for a CPU pin, rank `edge_logs` paths by summed `response.origin_time`, then match the
burst to Railway `--http` logs of the deployment live then (by `srcIp`) and to `activity_events` (by hr_id).
