---
name: heavy-ram-fix-2026-11-27
description: "27 Nov heavy RAM fix — the playwright + chrome-devtools MCP servers are REMOVED from ~/.claude.json (never re-add); spare got a second zram device, zram sysctls, MemoryLow on the live server and MemoryHigh on the preview."
metadata:
  node_type: memory
  type: project
  originSessionId: 5bce6de4-6864-4b47-a749-6e1b2a4ea0a8
  modified: 2026-11-27T16:50:08.297Z
---

Owner, 27 Nov 2026 ~18:40 Cairo: "I need a real heavy corrective action ... fix here this laptop and the spare laptop."

**Laptop**
- `playwright` and `chrome-devtools` were USER-level MCP servers in `~/.claude.json`, so EVERY session spawned both
  (cmd → npx → node, ~4 processes each per session): 90 processes, commit 36.6 → 31.2 GB when stopped. Removed;
  backup `~/.claude/backups/claude-json-mcp-20261127-184240.json`. Never re-add them — headless browsers are banned
  anyway (24 Nov rule: the app is driven only where he can watch it). Only `ask-gpt` stays user-level.
- Refused by the Claude Code safety check (auto-mode classifier, "Destructive or Unwanted Actions"): moving Docker
  Desktop's Run entry aside and `wsl --shutdown` (~300 MB). Left to him.
- What is left is the sessions themselves: each Claude Code CLI ~550–770 MB private, the app's renderers ~3.5 GB.

**Spare** (Ubuntu, 7.6 GB)
- `/etc/systemd/zram-generator.conf` gained `[zram1]` (ram/2, zstd, prio 100) beside zram0 — total compressed swap
  = RAM. Added as a second device so zram0 never had to be emptied. Backup `.bak-20261127`.
- `/etc/sysctl.d/99-phoenix-zram.conf`: page-cluster 0, watermark_boost_factor 0, watermark_scale_factor 125, swappiness 180.
- `systemctl set-property`: phoenix-dev `MemoryLow=3G` (live protected), phoenix-preview `MemoryHigh=3G` (preview
  squeezed into zram first). Files under `/etc/systemd/system.control/`.
- 🔴 **PREVIEW REPLACES LIVE** (his MCQ pick, 18:50): `spare-preview.ps1` stops phoenix-dev before starting the preview;
  the preview unit's ExecStopPost brings it back; `spare-follow-production.ps1` and `~/phoenix/nightly-restart.sh`
  (backup `.bak-20261127`) skip starting live while a preview runs. Preview now runs alone with heap 4 GB, 10 pages,
  MemoryHigh=infinity. Measured: spare available 611 → 3,960 MB when live paused beside the PR 851 preview.
- Sessions: he picked "Archive the six" — 4 archived (Approval workflows, Medical insurance sync, PEH-002, Engineering
  Hub discovery); "Visits with no locations" and "Excel extraction validation" refused by the app (live work attached).
- Trap: READING `/sys/class/zram-control/hot_add` CREATES a device — never `cat` it to look.

Related: [[spare-screen-is-blanked-and-quiet]]
