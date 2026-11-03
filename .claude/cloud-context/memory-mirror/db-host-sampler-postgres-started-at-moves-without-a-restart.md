---
name: db-host-sampler-postgres-started-at-moves-without-a-restart
description: "The db_host sampler's postgresStartedAt can move while pg_postmaster_start_time() does not, so that field alone never proves a database restart or a compute change - read memTotalMb and the SQL start time."
metadata:
  node_type: memory
  type: reference
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-02T13:11:35.183Z
---

On 2 Nov 2026 the sampler's `postgresStartedAt` moved to 14:43:23 Cairo, while `pg_postmaster_start_time()` stayed at 14:03 Cairo on 1 Nov, `memTotalMb` stayed 1,932, the Postgres log for 14:38-14:48 held no shutdown, start or FATAL, and web 5xx were 0. The field comes from the host's metrics (`process_start_time_seconds{service_type="postgresql"}`). Cause unknown.

**How to apply:** to prove a restart or a compute size, read `memTotalMb` (Small 1,932, Medium about 4,000) and `pg_postmaster_start_time()` together. A word that the dashboard changed is not the host either: that same afternoon Medium was reported from the dashboard, while the host read Small and so did Settings, Infrastructure when read at 15:05 Cairo (staging Micro, Future Talents Hub Nano).
