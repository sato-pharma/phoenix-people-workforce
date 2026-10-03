---
name: fast-forwarding-a-live-dev-servers-folder-trips-the-8gb-runaway-kill
description: "Fast-forwarding the folder a running dev server serves (83 commits, 2026-10-03) made it recompile to 8.07 GB, then 8.48 GB on the restart, and mem-watchdog's 8 GB runaway rule stopped it both times. Say so up front, and restart it rather than let him think a session closed it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: fbbdd50a-d200-4237-9d36-d3cb6c146f50
  modified: 2026-10-03T16:50:42.167Z
---

On 2026-10-03 the owner asked to see a merged change on his own dev server (port 3000, his `npm run dev` on the primary, 83 commits behind). He chose "update the main folder"; `git merge --ff-only origin/main` worked, but the server's rebuild grew to **8.07 GB** and `mem-watchdog.ps1` stopped it at 19:38 Cairo (`reason=runaway-dev-server-over-ceiling`, his 2026-09-21 rule). The restart (`node scripts/dev-server.mjs --port 3000`, whose 4 GB heap cap does NOT cap commit) reached **8.48 GB** while he browsed Phoenix CRM and was stopped again at 19:44. The launcher's own exit message names the cause ("STOPPED on its own").

**Why:** a far-behind checkout makes webpack recompile every route the browser touches, and the runaway line is commit, not heap. Free RAM was ~0.4-1.1 GB at the time.

**How to apply:** before moving a live dev server's folder by many commits, tell him it may cross the 8 GB line and be stopped by the watchdog; when it is, say so with the log line and restart it (never stop one yourself — [[never-stop-a-dev-server-at-all-until-he-says]]). The Hetzner preview box costs the laptop nothing for pushed code.
