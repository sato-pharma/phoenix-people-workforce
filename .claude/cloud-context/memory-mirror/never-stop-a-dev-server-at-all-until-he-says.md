---
name: never-stop-a-dev-server-at-all-until-he-says
description: "Owner re-tightened the dev-server rule on 2026-10-03 — NEVER close a dev server until he says so, including one this session started; the 2026-09-28 \"I may stop one I started myself\" carve-out is withdrawn"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 25cc1e8c-1129-481a-9f9d-cfbc3c48b869
  modified: 2026-10-03T07:23:36.515Z
---

🔴 **"DONT CLOSE THE DEV EVER UNTIL I SAY"** — owner, 2026-10-03, his own words, said while he was
watching a page in the pane. It **withdraws the 2026-09-28 carve-out** ("allow me to stop dev servers
I start myself"), which the global rules still record as *"one YOUR session started is yours to stop"*.
It is not: **no dev server is stopped by a session for any reason until he says so**, whoever started it.

**Why:** he browses the running app while a session is mid-change, and a server disappearing under him
costs him the thread. The earlier scoping existed to let a session tidy up after itself; he would
rather have the server than the tidiness.

**How to apply:**
- Never call `TaskStop` on a dev-server task, never `Stop-Process` the port's PID, never `pkill` it —
  not after verification, not to free RAM, not at the end of a task.
- A background dev server **can still die on its own**: `Bash(run_in_background)` stops it at its
  `timeout` (max 7,200,000 ms = 2 h, which is what to pass), `dev-server-reaper.mjs` kills it with the
  session, and `mem-watchdog.ps1` reaps a runaway over 8 GB or one idle 25 minutes. **Say so plainly
  when that happens** — "it was stopped by its time limit, I restarted it" — and restart it; do not
  let him think a session closed it.
- Starting one is still yours to judge from live free RAM ([[the-dev-server-is-a-local-exception]]).

Related: [[i-may-stop-a-dev-server-i-started-myself]] — that note is now **superseded**; keep it only
as the history of the rule it replaced.
