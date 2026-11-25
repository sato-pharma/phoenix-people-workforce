---
name: checkpoint-percent-reveals-a-compute-resize
description: "A production database restart that was really a compute RESIZE shows in Postgres's own checkpoint lines — \"wrote N buffers (P%)\" is N over shared_buffers, so the cache size before and after each restart can be read from the log after the fact."
metadata:
  node_type: memory
  type: project
  originSessionId: 23582dcf-f263-4a05-8d67-ca2c7297118b
  modified: 2026-11-25T19:31:37.142Z
---

Measured 25 Nov 2026 on the two production restarts (17:33 and 18:59 Cairo). `pg_settings` shows only
TODAY's `shared_buffers`, and nothing in the database records a compute change — but every
`checkpoint complete: wrote N buffers (P%)` line in `postgres_logs` is N ÷ shared_buffers:

- before 17:33: 1,090 = 0.8 % → ~131,000 buffers ≈ **1 GB** (the 4 GB machine)
- 17:34–18:59: 1,822 = 0.3 %, 1,052 = 0.2 % → ~525,000 buffers ≈ **4 GB** (a machine about four times bigger)
- after 18:59: 1,324 = 1.0 % → back to **1 GB**

So both "restarts" were a compute change up and then back down, made from the Supabase dashboard
or API — no Claude session ran one (transcripts searched: only reads). **The owner confirmed he made
both resizes himself** (25 Nov 2026, "Yes, it was me") — a planned change, not an incident. The 17:33 one shuts down in
order (PgBouncer `got SIGINT`, Postgres `terminating connection due to administrator command`,
`@supabase-infra/worker` re-registering the tenant at 17:34:06); the 18:59 one has no shutdown lines
and every service boots in the same second — the "killed from outside" shape the trap describes —
and it was STILL a planned resize, so that shape does not prove a platform fault.

**Why:** the [[a-production-postgres-crash-restart-wears-cloudflare-codes]] trap reads the 18:59 shape
as a platform kill and sends the owner to a support ticket; here the cause was a resize.
**How to apply:** before blaming the platform for a restart, compare the checkpoint percentage on
either side of it (`query_logs`, `source='postgres_logs'`, `event_message like 'checkpoint complete%'`).
A changed ratio means a resize, and only the owner can say who did it; resizing costs money, so it
is decided on the Supabase screen (Settings → Compute and Disk), never in chat.
