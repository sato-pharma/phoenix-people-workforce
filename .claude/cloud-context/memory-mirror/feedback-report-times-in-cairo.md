---
name: feedback-report-times-in-cairo
description: "User wants cron/schedule/timestamp times reported in Cairo local time, not raw UTC"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7fd28c01-1b85-4e3d-aac4-0dafb7be681f
---

Always convert times to Africa/Cairo local time when reporting cron schedules, deployment timestamps, or database timestamps to the user — don't just quote raw UTC.

**Why:** Vercel Cron schedules (`vercel.json`) are UTC-only by platform constraint, and Supabase/Postgres stores timestamps as UTC internally — so raw values are UTC by default. The user is based in Egypt and asked directly: "why is the time zone utc why it is not cairo egypt?" then confirmed "yes, convert to Cairo time going forward."

**How to apply:** Egypt observes EEST (UTC+3) in summer (roughly late April–late October) and EET (UTC+2) in winter — check which is active for the current date before converting, don't hardcode +3. When quoting a cron schedule or a `started_at`/`completed_at`-style timestamp, state the Cairo-local equivalent (e.g. "19:00 UTC = 10:00 PM Cairo time (EEST, UTC+3)"), optionally alongside the raw UTC value for precision in ops/debugging contexts. This mirrors the existing code convention already used in this repo (see the `vacation-module.test.ts` / `contract-renewal-hardening.test.ts` cron-schedule comments, which already annotate UTC→Cairo conversions for the same reason).
