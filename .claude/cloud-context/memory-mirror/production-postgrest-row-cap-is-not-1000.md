---
name: production-postgrest-row-cap-is-not-1000
description: "Production PostgREST has NO row ceiling (105,103 rows in ONE unpaged read on 7 Nov 2026; 143,671 on 22 Oct) while STAGING caps at 1,000 — so the only 1,000 that can cut a read on production is one the code writes itself; the ratchet and the supabase_row_ceiling tripwire now guard it."
metadata:
  node_type: memory
  type: reference
  originSessionId: 22d65e5a-afd2-4f60-94b1-232c121ffb84
  modified: 2026-11-06T22:25:54.587Z
---

**Production (`ozucdzovmcqvepbozvqf`) has no `max_rows` ceiling.** Measured read-only with the service key:
22 Oct 2026 — 143,671 `ireports360_visits` rows and all 4,640 October `phoenix_crm_visits` rows in one
response; 7 Nov 2026 — 105,103 `source_of_sales_customer_map` rows and 79,792 `phoenix_crm_visits` rows in
one response each (`content-range: 0-105102/105103`). `supabase/config.toml` (`max_rows = 1000`) only
configures the LOCAL stack, and a test pins it, so leave it.

**Staging DOES cap at 1,000** (`206`, `content-range: 0-999/66109`, probed once read-only on 7 Nov 2026,
before the owner ruled staging out of the work). A read that is right on production alone is untested on
staging. Nothing was changed on staging.

**Why it matters:** because production is uncapped, an unpaged `.select()` is not a live truncation there —
a code audit that ranked one as the top defect "because the 1,000 cap truncates it" was wrong
(22 Oct 2026). What DOES cut a read on production is a cap the code writes itself: `.limit(1000)`,
`ROW_LIMIT = 1000`, `maxRows: 1_000`. The 7 Nov 2026 audit found and removed those.

**How to apply:** before reporting an unpaged select as truncating on production, probe the ceiling
(read-only, `select=id` on a big table, compare `returned` with the total in `content-range`). Never write a
hard 1,000: `tests/row-cap-ratchet.test.ts` refuses it. The Max rows dashboard setting is invisible from the
repo and a restored project returns to 1,000, so `src/lib/supabase/row-cap-watch.ts` logs
`supabase_row_ceiling` when an unpaged GET answers `0-999/…`. Account: `docs/postgrest-row-ceiling.md`.
Related: [[postgrest-unbounded-select-silently-stops-at-1000-rows]].
