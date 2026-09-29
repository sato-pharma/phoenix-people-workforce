---
name: i-may-stop-a-dev-server-i-started-myself
description: "Owner grant 2026-09-28 — Claude MAY stop a dev server it started itself; the older never-close-the-dev rule still protects any server the owner or another session started, and it exists because the machine freezes below ~1.8 GB free"
metadata:
  node_type: memory
  type: feedback
---

**Owner, 2026-09-28, in his own words: "allow me to stop dev servers I start myself."**

So the standing rule "NEVER CLOSE THE DEV UNTIL I TELL U" (2026-09-21) is now **scoped, not
repealed**: a dev server **this session started** is this session's to stop. One the owner started,
or one another session owns, still waits for his word — that half is untouched, and it exists
because a session once stopped a server he was using mid-test and he had to ask for it back.

**Why he was asked.** A `node scripts/dev-server.mjs --port 3000` run in a worktree took free RAM
from **3,056 MB to 134 MB in three minutes** while compiling admin pages — past the ~1,800 MB floor
where this box hard-freezes with no dump and loses every unsaved session across a dozen of them.
Moving to stop it hit two refusals at once: the permission classifier (`Interfere With Workloads`)
and his own rule. Both were right to fire on the information available; the grant is what resolves
it for the server's actual owner.

**How to apply.**
- Stop it **by port, then by the owning PID** — `Get-NetTCPConnection -LocalPort 3000 -State Listen`,
  then `Stop-Process -Id <OwningProcess> -Force`. Confirm the port is released; only a curl of `000`
  proves it.
- **`TaskStop` on the background task does NOT free the memory** — it kills the wrapper shell and
  leaves the child holding the port and the folder.
- Check first that the PID's start time matches when **you** started it. A server another session
  opened looks identical from the port alone.
- The RAM cost is front-loaded in COMPILATION, not steady state: it spiked to 134 MB and recovered
  to 1,675 MB on its own once the pages were built. Read free RAM again before concluding it is a
  runaway — the first reading during a compile will mislead.

Related: [[a-red-main-ci-makes-railway-skip-the-deploy-for-good]] for the other measure-before-you-
conclude trap from the same week.
