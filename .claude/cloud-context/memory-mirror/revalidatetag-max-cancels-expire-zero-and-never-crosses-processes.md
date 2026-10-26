---
name: revalidatetag-max-cancels-expire-zero-and-never-crosses-processes
description: "A later revalidateTag(tag,\"max\") in the same request undoes an earlier {expire:0}; a bust on the worker never reaches the website's cache"
metadata:
  node_type: memory
  type: project
  originSessionId: 967895cf-b5cb-427d-a989-2a8404633ee0
  modified: 2026-10-25T21:49:41.169Z
---

Next 16.4.2 here has no `cacheHandler`, so the tag state is a module-level Map in EACH process (website and worker).

- `revalidateTag(tag, "max")` sets `stale=now, expired=now+365d`: the next read gets the OLD value (stale-while-revalidate). `{ expire: 0 }` sets `expired=now`, so the next read waits for fresh data.
- Pending tags apply in insertion order, so a "max" AFTER an `{expire:0}` on the same tag cancels the immediate expiry. Found 26 Oct 2026 at `app/api/vacation/company-report/approve/route.ts:140`.
- A `revalidateTag` run by a worker-only route (`refuseOnPageServer`, e.g. `cron/crm-contact-lists`) busts only the worker's copy; the website heals by TTL alone.

**Why:** both look correct in a code read and both have shipped; VAC-0686 was the first.
**How to apply:** use `{expire:0}` wherever the writer's own next screen must show the write; never follow it with "max"; never expect a worker bust to refresh a page. Full audit: `docs/production-audits/cache-audit-2026-10-26.md` in `_wt-cache-audit`. Related: [[vacation-report-cross-request-cache-live-on-prod-2026-08-14]].
