---
name: next-2mb-data-cache-throws-only-in-dev-and-kills-the-server
description: "An unstable_cache entry over 2MB kills the dev server via a detached promise, and in production silently skips the write so the cache stops existing with no error"
metadata: 
  node_type: memory
  type: project
  originSessionId: 84a6d667-0635-4a31-b278-162136c6bbd5
  modified: 2026-08-22T16:36:51.889Z
---

Next refuses any `unstable_cache` entry whose serialized size exceeds **2MB**, and the two runtimes
fail in opposite, equally misleading ways (`next/dist/server/lib/incremental-cache/index.js`, the
`if (this.dev) throw … console.warn(warningText); return;` branch):

- **In dev it THROWS**, and the throw lands on a promise Next never awaits and never catches —
  `workStore.pendingRevalidates[key] = cacheNewResult(...)` in
  `next/dist/server/web/spec-extension/unstable-cache.js`. It surfaces as `unhandledRejection` and
  Node kills the whole dev server (`exit code 3221226505` / `0xC0000409`). **No try/catch anywhere
  in our code can stop it** — the only defence is to never hand over an oversize entry.
- **In production it only `console.warn`s and skips the write.** Quieter and in one way worse: the
  cache silently stops existing and every render pays the full query again, with nothing to say so.

Found 2026-08-22 on `loadAchievementRange` (`src/lib/sales/vs-target.ts`), the field force's single
most expensive query. Measured live: **6,950 rows for 2026-01..2026-08 = 2,799,322 bytes** bare
(Next measured 3,189,652 including its own envelope), growing ~870 rows / ~415KB **per month**. It
crossed 2MB around 2026-05, so no `SALES_HISTORY_FLOOR`-anchored range would ever fit raw again —
production had been re-running 2.38s of database time on every `/admin` load for months while
believing it was cached.

**Fix used: store the rows gzipped + base64** inside the cached function, unpack outside. 11.2x
smaller (2,799,322 → 248,864 bytes, 11.9% of the limit, ~40 months of headroom). `packAchievementRows`
returns **null** rather than ever offering an oversize entry, and the caller then reads live.

**Why:** a size-based dodge that only shrinks the payload rots — the data grows monotonically. The
null bypass is what makes the crash structurally impossible, not the compression.

**How to apply:** any `unstable_cache` holding a row SET rather than a scalar is a candidate — this
repo has ~20 call sites. Before adding one, ask what it looks like in 12 months, not today. The
precedent fix in `src/lib/sales/sos-dashboard.ts` (route oversize callers straight to the uncached
fetcher) is the other valid shape when compression is not worth it. Never diagnose this from the dev
crash alone: production is failing too, just silently. See [[dont-foreground-watch-long-pipelines]]
and [[turbopack-500s-with-0xc0000142-when-commit-is-full]].
