---
name: production-postgrest-row-cap-is-not-1000
description: "Production PostgREST returned 143,671 rows in ONE unpaged read on 22 Oct 2026 — the 1,000-row cap in supabase/config.toml and the repo rules is NOT what production enforces; probe before reporting an unpaged read as a live truncation defect (staging not probed)."
metadata:
  node_type: memory
  type: reference
  originSessionId: 8d344ac4-7d9c-4bb1-9283-58210ce1498d
  modified: 2026-10-22T05:17:36.759Z
---

On 22 Oct 2026 (~08:15 Cairo) a read-only unpaged request with the service key against production
`ozucdzovmcqvepbozvqf` returned **143,671** `ireports360_visits` rows (`select=id`, no filter, no range)
and all **4,640** October `phoenix_crm_visits` rows in a single response (`content-range: 0-4639/*`).
So production's effective `max_rows` is far above 1,000 — `supabase/config.toml` (`max_rows = 1000`) only
configures the LOCAL stack, and the repo notes that say "PostgREST stops at 1,000 rows" describe the
default, not the hosted setting as it stands today.

**Why it matters:** a read-only code audit of every visit reader ranked `loadPhoenixWorkEvidenceDays`
(unpaged, feeds the no-activity deduction suppressors) as the top live defect "because the 1,000-row cap
truncates it silently". That premise was false on production; only the probe showed it.

**How to apply:** before reporting an unpaged select as truncating on production, probe the real ceiling
the same way (read-only, `select=id` on a big table). Staging was NOT probed. Still page any NEW read that
grows with the field — the ceiling is a project setting someone can lower, and the repo's own rule
(`fetchAllRowsKeyset`) stays the standard for new code. Related: [[postgrest-unbounded-select-silently-stops-at-1000-rows]].
