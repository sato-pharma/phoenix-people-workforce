---
name: every-db-round-trip-crosses-the-atlantic
description: "Railway runs in sfo (US West), Supabase in eu-central-1 (Frankfurt) — every DB round trip is transatlantic, so paginated scan COUNT dominates, not query time"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2d66b5e6-1a1a-44ee-8e95-86506c216715
  modified: 2026-08-05T12:25:06.421Z
---

The app server and the database are on different continents. Railway service
`phoenix-people-workforce` runs in **`sfo` (US West)**; Supabase production
(`ozucdzovmcqvepbozvqf`) is **`eu-central-1` (Frankfurt)**. Every PostgREST call pays
~150-250 ms of pure latency before Postgres does any work.

**Why:** found 2026-08-05 diagnosing the `crm` deductions connector, which died at the 300 s
gateway and reported as "1 connector(s) failed" with no warning. Postgres answered the whole
July visit month in **61 ms**; the request still ran past 300 s. The cost was
`round trips × transatlantic latency`, nothing else.

`src/lib/crm/reads.ts` paginates with `DEFAULT_PAGE_SIZE = 1000`, so July 2026's **18,544**
`ireports360_visits` rows = **19 sequential round trips per scan**. The connector ran that same
scan **11 times** (once per leaver + once in the zero-signal check), none of them
employee-filtered — each pulled the whole company and discarded all but one person's rows.
~209 round trips. Fixed in #1775 by hoisting ONE shared month scan (11 → 1).

**How to apply:** when a server-side route is slow, count the ROUND TRIPS before optimising SQL.
`explain analyze` will look fine and tell you nothing. Watch for: a paginated scan inside a
per-entity loop; the same range scanned by several helpers; a scan that isn't filtered by the
entity it is about. Hoist one shared read and filter in memory — safe whenever the consumer is
bounded independently of the fetch window. Sizing check:
`select count(*) from <table> where <range>` ÷ page size = round trips.
Related: [[dont-foreground-watch-long-pipelines]].
