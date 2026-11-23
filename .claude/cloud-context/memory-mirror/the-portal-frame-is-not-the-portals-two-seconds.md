---
name: the-portal-frame-is-not-the-portals-two-seconds
description: "Measured 23 Nov 2026 — every employee-portal page reads ~2 s in page_timings, but the portal frame costs ~0.1-0.2 s on production; the rest is the phone's connection and each page's own content. A docs fix to the private-calendar rule saying otherwise is PARKED on branch codex/portal-frame-speed."
metadata:
  node_type: memory
  type: project
  originSessionId: 13be9376-17b9-44e2-82bc-bc64a093c5df
  modified: 2026-11-23T18:25:26.082Z
---

`page_timings` TTFB is the phone's `navigation.responseStart` (connection, TLS, redirects and server), so a
portal page reads ~2 s while admin pages, mostly on office desktops, read ~0.7 s. Measured on 23 Nov 2026,
the frame (`employee-portal-server-shell.tsx`) makes one wave of 5 calls for its own data plus 3–4 waves of
9 calls for the Phoenix CRM sidebar check (`phoenixCrmSidebarEntries`), each 3–6 ms in the database
(pg_stat_statements), so about 0.1–0.2 s on production. Railway's `upstreamRqDuration` for a whole My Visits
page was a median 1.0 s against ~1.8 s on the phone. So don't "speed up the frame" again without a new
measurement. Server time per request comes from `railway logs --http --json` (`upstreamRqDuration`); the
calls behind a function are listed by wrapping `fetch` in a script run on the spare (read only).

**Why:** the owner asked to "speed up the frame" on 23 Nov; the measurement showed nothing worth cutting.
Changing it anyway would have been unrequested work.

**How to apply:** PR 723 merged a line in `.claude/rules/private-calendar.md` blaming the frame. The
correction is committed on the pushed, PR-less branch `codex/portal-frame-speed` (commit c2f570a25 plus a
mirror refresh). Carry it into the next PR that touches the private calendar or the portal, instead of
opening a docs-only PR. Related: [[the-spare-laptop-was-reinstalled-2026-11-20]].
