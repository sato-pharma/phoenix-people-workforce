---
name: the-spare-has-a-browser-guard
description: "Since 14 Nov 2026 (his 'Yes, guard it') the spare laptop stops automated browser jobs by itself when its free memory stays under 1,200 MB; the source is ~/.claude/scripts/spare-browser-guard.ps1 on the main laptop and the 10-minute follow task installs it on the spare."
metadata:
  node_type: memory
  type: project
  originSessionId: c5b70fea-e1b9-4553-ac78-c360261fb13e
  modified: 2026-11-14T18:01:25.780Z
---

On 14 Nov 2026 the 8 GB spare laptop was left with 244 MB free at 17:47 and 303 MB free at 19:07, from the dev server plus browser jobs sent from the main laptop (the run-phoenix-workforce driver and the Phoenix Inspect explorer). At 19:13 it reset every SSH connection, at 19:23 it left the network, and afterwards it restarted at the ASUS logo on every start. No session had changed anything in its Windows: 853 commands over two weeks, and the only system-level ones were the 7 Nov setup (winget Node, `wsl --shutdown`). Asked "Once the spare is back, should browser jobs stop running on it while memory is low?", the owner answered **"Yes, guard it"** (about 20:00 Cairo).

**What exists (built 14 Nov 2026, about 20:00 Cairo):**
- `~/.claude/scripts/spare-browser-guard.ps1`: the source. On the spare it runs as `D:\Phoenix\browser-guard.ps1` from the task "Phoenix Spare Browser Guard" (at startup, as SYSTEM, restarted if it stops, one copy at a time through a mutex).
- Every 2 s it reads free memory. Under 1,200 MB on two readings in a row, it stops every chrome / msedge / chromium / headless-shell process started with `--remote-debugging-pipe` (how Playwright launches one; a browser a person opens never has it), plus the node script that launched it. It never stops a runner whose command line matches the dev server, `next`, `start-server.js` or pnpm. Log: `D:\Phoenix\browser-guard.log`.
- `spare-follow-production.ps1` (the 10-minute "Phoenix Spare Dev Server Follows" task) reads the task's state and the copy's SHA-256 on every run. A missing task, a stopped one or an old copy gets reinstalled, and that is logged in `~/.claude/logs/spare-follow-production.log` as "browser guard on the spare was ...". The pre-change copy is `spare-follow-production.ps1.bak-20261114-before-browser-guard`.

**Proven here, not yet on the spare:** both scripts parse and are pure ASCII. On the main laptop a fake browser job (a copy of node.exe named chrome.exe with `--remote-debugging-pipe`) was stopped along with its runner. A second one hung off a script named `dev-server.mjs` lost its browser and kept its runner. The running loop stopped a job about 4 s after it began, and a second guard exited at once. The install on the spare has not run yet, because the spare was in a restart loop when this was built. The first follow run after it answers installs it; read that log line before calling it live.

**How to apply:**
- Change the guard only in `~/.claude/scripts/spare-browser-guard.ps1`, never on the spare. The next follow run replaces the spare's copy. Keep it ASCII.
- A browser job that dies on the spare with a closed browser: read `D:\Phoenix\browser-guard.log` first, because the guard may have stopped it. The answer is less on the spare at once, never a lower threshold.

Related: [[the-spare-laptop-changes-address-it-is-not-off]]
