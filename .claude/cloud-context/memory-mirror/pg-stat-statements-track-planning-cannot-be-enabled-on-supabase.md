---
name: pg-stat-statements-track-planning-cannot-be-enabled-on-supabase
description: `pg_stat_statements.track_planning` stays off on production and cannot be turned on — SQL is denied (42501, the postgres role is not a true superuser) and the CLI's `postgres-config update` answers 400 "Unrecognized key"; measure planning time with EXPLAIN (ANALYZE) on a warm second run instead.
metadata:
  type: reference
---

Tried 2026-10-10, both routes, on production `ozucdzovmcqvepbozvqf` (the only override there is `max_connections=200`):

- `alter database postgres set pg_stat_statements.track_planning = on` → `42501 permission denied to set parameter`, although `pg_settings.context` reads `superuser`.
- `supabase --experimental postgres-config update --config pg_stat_statements.track_planning=true --no-restart` → HTTP 400 `Unrecognized key`. The CLI command needs the `--experimental` flag; `get` is read-only and safe.

Nothing changed on either side — setting still `off`, overrides still `max_connections` only.

**Why it matters:** planning time reads 0 in every `pg_stat_statements` number taken off this database, which is how a 63.6 ms planning figure got reported as a lead on 2026-10-10 and then retracted — it was a COLD plan (1,592 planning buffers read from disk), steady state was 2–6 ms.

**How to apply:** do not retry either route or offer it as a "cheap one-setting fix". Measure planning time with `EXPLAIN (ANALYZE, BUFFERS)` and read it on the SECOND run, once the catalogs are warm, never the first. Related: [[set-config-call-count-is-the-round-trip-count]].
