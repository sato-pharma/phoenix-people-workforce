---
name: railway-http-path-has-no-query-so-prefetches-look-like-page-opens
description: "Railway's HTTP log `path` drops the query string, so `_rsc` prefetches read as full page opens; separate real opens by bytes (30 KB or more)"
metadata:
  node_type: memory
  type: reference
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-02T10:43:12.027Z
---

Railway's `--http --json` rows carry `path` with NO query string, so `?_rsc=` is invisible and a prefetch of a page reads exactly like a real open of it. Measured on `/employee-portals` 2 Nov 2026: the share over 3 s read 14.1% → 10.6% with prefetches in the count, and 71% → 59% on real opens. The "1 in 9 opens is slow" I told him came from this and was wrong; about 6 in 10 were.

**How to apply:** count a real page open by response bytes (30 KB or more on the portal home), never by the path alone. Say which of the two a number is.

Related: [[verify-the-emitted-artifact-never-the-source]].
