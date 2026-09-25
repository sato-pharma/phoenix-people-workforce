---
name: railway-production-region-is-now-eu-west
description: "Production Railway service moved sfo -> europe-west4 (Amsterdam) on 2026-08-09, colocated with the Frankfurt DB."
metadata: 
  node_type: memory
  type: project
  originSessionId: e32dec38-db15-4bf6-92d6-6bcd91afa4d7
  modified: 2026-08-09T12:48:22.424Z
---

Production (`phoenix-people-workforce`) runs in **`europe-west4-drams3a` (Amsterdam, EU West)**
since **2026-08-09**, 1 replica. It was `sfo` (San Francisco) from the 2026-08-01 emergency GCP
cutover until then.

**AGENTS.md §3 was corrected to match in #1956 (`9d7312c4`, 2026-08-09)** — it now names the region,
the colocation rule, and the measurement. No action needed there; trust it.

**Why it mattered (this was the "portal is slow" root cause).** The DB is Supabase `eu-central-1`
(Frankfurt) and users are in Cairo, so `sfo` put the app on the far side of the planet from both.
Measured on `/api/healthz`, a route that does zero work (no DB, no network):

| | server-side time (TTFB − TLS-complete) |
| --- | --- |
| sfo | **~204 ms** (n=10) |
| europe-west4 | **~75 ms** (n=12) |

`/login` (real SSR) landed at 81 ms after the move. Every DB round trip also stopped crossing the
Atlantic. This was NOT a code, query, or database-capacity problem — Postgres was idle throughout
(1 active connection).

The cutover had silently discarded a deliberate optimization: `.github/workflows/deploy-cloud-run.yml`
pinned `REGION: europe-west3` on 2026-07-17 precisely to colocate with Supabase ("same metro, ~1ms"
and "~57ms from Cairo vs ~146ms from Iowa"). **If production is ever re-platformed again, put it in
Europe on day one** — see [[railway-merge-is-the-production-deploy]].

Related: [[railway-scale-us-west-does-not-zero-sfo]], [[every-db-round-trip-crosses-the-atlantic]].
