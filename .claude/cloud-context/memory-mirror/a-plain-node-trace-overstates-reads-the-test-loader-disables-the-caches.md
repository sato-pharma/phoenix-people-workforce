---
name: a-plain-node-trace-overstates-reads-the-test-loader-disables-the-caches
description: "tests/alias-loader.mjs stubs unstable_cache to a pass-through and React cache is a pass-through outside a render, so a Node trace counts reads production never makes"
metadata:
  node_type: memory
  type: feedback
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-02T10:43:12.732Z
---

A request waterfall traced in plain Node under `tests/alias-loader.mjs` overstates reads: that loader stubs `unstable_cache` to a pass-through, and React's `cache` does nothing outside a render. On 2 Nov 2026 it blamed the sidebar's 9 reads, `phx_sales_vs_target_range` and vacation's 1.7 MB `select=*` on the portal home, none of which production makes on a warm open.

**Why:** chasing those would have fixed reads that do not happen, and missed the card that actually finished last.

**How to apply:** for a faithful trace use a loader that keeps both caches working (a Map-backed `unstable_cache`, a per-request `cache` keyed on a `globalThis` map reset per open), warm the shared caches with a first person, then measure a second. Trust the ORDER of such a trace, never its absolute times.

Related: [[railway-http-path-has-no-query-so-prefetches-look-like-page-opens]].
