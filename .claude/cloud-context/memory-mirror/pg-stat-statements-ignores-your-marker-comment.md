---
name: pg-stat-statements-ignores-your-marker-comment
description: A /*marker*/ comment does NOT give a probe its own pg_stat_statements row — the queryid is the parse tree, so a before/after pair accumulates into ONE row and must be read as a delta over calls.
metadata:
  type: project
---

`pg_stat_statements` computes `queryid` from the **post-parse tree**, not from the query text.
Comments are not part of the tree, so two probes that differ only by a `/*probe-before*/` versus
`/*probe-after*/` marker land on the **same row**, and the stored `query` text is whichever ran
first.

Measured 23 October 2026 while proving the contact-truth cache: the "after" probes appeared to have
vanished, and `probe-wide-window` instead read 3,069.3 ms over **2 calls** — the before (2,948.2 ms)
plus the after, summed.

**How to apply:** always select `calls` alongside the totals, and compute the per-call figure as a
difference: run the probe, record `calls`/`total_exec_time`/`shared_blks_hit + shared_blks_read`,
make the change, run it again, and subtract. A `mean_exec_time` across a before/after pair is
meaningless — it averages the two worlds. To get a genuinely separate row, change the STATEMENT
(a different literal count, an extra constant column), not the comment.

Related: the window matters as much as the key — `pg_stat_statements_info.stats_reset` on production
was 22 Oct 11:25 UTC, which is *before* two fixes landed that day, so the 20-hour mean overstated
the live cost of the CRM doors by an order of magnitude. Read the reset time before quoting a mean.
See [[the-22-oct-stall-was-four-database-machine-restarts]].
