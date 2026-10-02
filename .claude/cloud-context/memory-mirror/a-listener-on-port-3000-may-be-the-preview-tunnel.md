---
name: a-listener-on-port-3000-may-be-the-preview-tunnel
description: "A process listening on localhost 3000/3001 may be the SSH tunnel to the Hetzner preview box (ssh.exe -L 300x:127.0.0.1:300x phx@46.225.184.142, a few MB), NOT a local Next.js dev server — read the listener's command line before calling it a dev server, recommending a stop, or counting it as RAM to reclaim."
metadata:
  node_type: memory
  type: project
  originSessionId: 60e0f2be-a803-444e-bf13-8a9f6b62c24c
  modified: 2026-10-02T16:20:43.774Z
---

On 2026-10-02 a session saw listeners on ports 3000 and 3001 under RAM pressure, called them "dev servers",
and recommended stopping the older one to free ~3.5 GB. The owner said yes. Both were **`ssh.exe` port
forwards to the Hetzner preview box** (`-N -L 3000:127.0.0.1:3000` and `-L 3001:127.0.0.1:3001` to
`phx@46.225.184.142`), holding 3 MB and 7 MB. Stopping one frees nothing and cuts his `phx-preview` look.
Neither was stopped.

**Why:** the session-census hook's "stop a dev server first — returns ~3.5 GB" advice is about a local
`next dev`; since the preview box took over browser looks (AGENTS.md §5), the port alone no longer says which
it is.

**How to apply:** before naming a listener a dev server, read `Get-NetTCPConnection -LocalPort <p> -State Listen`
→ `Win32_Process` CommandLine. `ssh.exe … -L` = the preview tunnel (leave it); `node … next`/`dev-server.mjs`
= a real dev server. On 2026-10-02 the RAM actually sat in the Claude app (~5.3 GB across 25 processes) and
Edge (~3.2 GB) — his windows, his call. Related: [[i-may-stop-a-dev-server-i-started-myself]].
