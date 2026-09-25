---
name: postgrest-unbounded-select-silently-stops-at-1000-rows
description: "A PostgREST select with no .range() caps at 1000 rows with no error and no marker - the array just stops, so a truth set built from it silently misclassifies"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5a07dad9-dbfb-4fdd-b07e-449eb2990ac1
  modified: 2026-08-27T14:41:08.412Z
---

**A Supabase/PostgREST `.select()` with no `.range()` returns at most 1000 rows, with no error, no
marker, and no truncation flag.** The array simply stops. Nothing distinguishes "these are all the
rows" from "these are the first 1000".

Found 2026-08-27 in `scripts/recruitment-reread-never-read-cvs.ts`, which decided *who counts as
already read* from one unbounded select over `ats_candidate_cv_extractions`:

- The table held **912 rows against 431 candidates** - **88 rows from the cap**.
- That same script **adds one row per candidate it reads**, so it was walking itself into it.
- Past the cap, rows fall off, their candidates drop out of `readIds`, and a candidate the model
  HAS read gets re-read as "never read" while another freezes out of the set permanently.

Fixed in #2456 with an explicitly ordered `.range()` loop that pages until a short page proves the
end. **The explicit `.order()` matters twice**: without one the page boundaries are undefined (a row
can come back twice or never), and any newest-row-per-candidate map is built from that order.

**How to check:** `select count(*) from <table>` before trusting any unbounded select over it. If
the count is near 1000 - or the code path grows the table - page it.

This is a DIFFERENT trap from
[[postgrest-in-with-hundreds-of-ids-silently-returns-nothing]], which is about the URL length of a
large `.in()` filter returning `{data: [], error: null}`. Both are silent; this one truncates, that
one empties. Related: [[n-live-tup-is-stale-use-real-count]].

**Where it is NOT a risk:** a select already narrowed by `.in("candidate_id", batch)` with a small
batch. Checked that day - `candidates.ts` (3 sites) and `contact-review-service.ts` all batch, so
they were not exposed the same way. But a big batch times several rows per id can still cross 1000.
