---
name: a-minute-long-portal-load-in-the-app-pane-is-the-laptop
description: "60–120 s \"Loading employee portal page\" readings taken in the desktop app's browser pane on this laptop were the starved browser, not the server — check the HTTP log's totalDuration before hunting a server cause."
metadata:
  node_type: memory
  type: project
  originSessionId: 6d493323-344a-4529-8b00-4859c9cb45e4
  modified: 2026-10-26T04:03:56.317Z
---

26 Oct 2026, the Pedia National Sales Manager seat (A-12): the browser timing beacon reported first paints of 20–75 s and the targets page was said to take over 95 s. But Railway's HTTP log showed every one of those documents served in 0.4–2.2 s (visits 5.1 s), static chunks in 33 ms or less, and every database call in the render window under 0.6 s. The gap sat between the document finishing and the first client effect starting (75 s on territory-management), so it was spent in the browser. The observer was this laptop (Claude desktop user agent, alternating with the pane's "Android 14; Pixel 8" emulation) with 635 MB of free RAM.

The top database load at the time, the Reps List contact roster page walk (22% of pg_stat_statements total), had already been fixed by PR #6473, merged 26 Oct at 00:09 Cairo. Its counter was history from before the 25 Oct 16:14 reset.

**Why:** a session nearly shipped an invented server fix for a client-side stall.
**How to apply:** for any "page takes a minute" report, first read the HTTP log's `totalDuration` for that path and IP, then compare it with the beacon's first paint; check pg_stat_statements' `stats_reset` and the fix history before calling a query the top load. Related: [[collapsed-browser-pane-reads-zero]].
