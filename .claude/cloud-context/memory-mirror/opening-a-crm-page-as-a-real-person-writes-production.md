---
name: opening-a-crm-page-as-a-real-person-writes-production
description: "A local look with --hrId is not read-only - a Phoenix CRM page posts its badge-clear for that person, and context.route misses beacons."
metadata:
  node_type: memory
  type: project
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-01T23:17:31.350Z
---

Opening a Phoenix CRM module as a real person (`--hrId`) on the local dev server, which reads production, sent writes on 1 Nov 2026:

- `PhoenixCrmNoticesSeen` POSTs `/api/phoenix-crm/notices/seen` when the page mounts with an unread notice, clearing that person's "new" badge. The route now refuses a local preview (`isPreviewSession`).
- `/api/activity/track` also fires, but it refuses a local preview, so it left no row (checked in `activity_events`, 1 Nov 2026).
- The touch trail did the same until it was retired (PR 6760, 1 Nov 2026); its route and table no longer exist.

Playwright's `context.route` does NOT stop them all: `sendBeacon` and keepalive calls from a closing page still reached the server on 1 Nov 2026.

**Why:** a look under a rep's id can clear their badge, and nothing on screen says so.

**How to apply:** `driver.mjs` now stops every non-GET, in the page and at the network, and prints `writes stopped (N)`; drive from a current checkout. Any other browser route to a real person's page (the Browser pane, a hand-written Playwright script) has none of this. A write the server makes while answering a GET is NOT stopped, so `writes stopped (0)` does not prove nothing was written.
