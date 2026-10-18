---
name: the-preview-box-runs-two-checkouts-so-never-pkill-by-name
description: "RETIRED 2026-10-17 - phx-preview, its two checkouts and preview-start.sh are gone from the box; what still holds is the rule: on the box stop a server by its PORT or scope name, never `pkill` by name (live-ctl.sh does). History: the Hetzner preview box ran TWO preview checkouts (preview on 3000, preview-b on 3001), so a session never owns it - `pkill -f \"next dev\"` there killed every session's preview. Both phx-preview.ps1 -Stop and preview-start.sh are port-scoped since 2026-10-03; never widen them back."
metadata:
  node_type: memory
  type: project
  originSessionId: 8bf7ccfe-bc48-47b1-936a-ca1e1140afa2
  modified: 2026-10-03T07:02:26.050Z
---

**The box is shared, and nothing about it says so.** `/home/phx/preview` serves port 3000 and
`/home/phx/preview-b` serves port 3001, each a separate clone on a separate branch, reached by
separate ssh tunnels. A session that runs `phx-preview` is therefore taking a resource another
session may be mid-review on.

🔴 **Until 2026-10-03 both halves killed BY NAME.** `phx-preview.ps1 -Stop` ran
`pkill -f 'next dev'` and `/home/phx/preview-start.sh` ran the same line before starting — so
**starting** a preview silently killed whatever anyone else was looking at. Nothing warned either
side: the other session's tunnel simply stops answering, which reads as the box being broken rather
than as someone having stopped it. Caught while pointing the checkout at a branch with a peer
mid-review on 3001; the peer's server was spared only because the kill was replaced first.

**Both are port-scoped now.** `/home/phx/preview-stop.sh <port>` is the single implementation
(find the `dev-server.mjs --port N` wrapper and the pid actually listening on `127.0.0.1:N`, kill
those two, then prove the port is dead with a curl); `preview-start.sh` mirrors it inline on purpose
so starting never depends on that file existing. Proven both ways on 2026-10-03: with a server on
3000 and the peer on 3001, `-Stop` killed exactly 3000's two pids and left 3001 answering 200; with
3000 empty it killed nothing. **Never widen either back to a name match.** Backups:
`phx-preview.ps1.bak-20261003-pre-scoped-kill`, `/home/phx/preview-start.sh.bak-20261003-pre-scoped-kill`.

🔴 **Two more things about that box a session gets wrong:** `dev-server.mjs` REFUSES to start a
second server there (its message quotes the LAPTOP's "16 GB … peaks near 6 GB", which is copied
text — the box is 7.7 GB and an idle server there is ~9 MB RSS), so a second preview needs
`PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS=1` and a real look at `free -m` first. And **Chromium is not
installed on the box**, so every PDF/PNG render answers **503 ChromiumUnavailable** — that is the
box, not a defect in the code, and it cannot be verified there at all.

**Why:** the owner's rule is that another session's dev server waits for his word; a tool that kills
one by name breaks that rule on the session's behalf, silently.

**How to apply:** stop anything on that box by PORT, never by task or process name — the same rule
AGENTS.md §5 states for the laptop. Before taking port 3000, check what else is running
(`ps -eo pid,args | grep "next dev"`) and say so. Related:
[[a-listener-on-port-3000-may-be-the-preview-tunnel]].
