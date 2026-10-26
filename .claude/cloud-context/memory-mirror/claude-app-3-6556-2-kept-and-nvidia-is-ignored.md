---
name: claude-app-3-6556-2-kept-and-nvidia-is-ignored
description: 2026-10-26 the Claude app auto-updated 2.31226.1 → 3.6556.2 on a restart and the owner chose to KEEP it; the Windows NVIDIA GPU preference does not move Claude off the Intel chip
metadata:
  node_type: memory
  type: project
  originSessionId: 7cf6f167-fc8f-4d6f-b991-a5f53b961c08
  modified: 2026-10-26T14:49:11.042Z
---

On 2026-10-26 17:35 Cairo a quit-and-reopen of the Claude app applied a pending MSIX update: **2.31226.1 → 3.6556.2**. At ~17:40 Cairo the owner chose **"Keep 3.6556.2"** over reinstalling his kept Claude-2.31226.1.msix. The 3.6556.2 `app.asar` carries the turn box (`ccd_turn` ×11, `promptSuggestions=void 0` ×2), so NEW sessions get `mcp__ccd_turn__wrap_up` reply buttons, not ghost text — ship the Next-step words as `actions[0].message` there. Supersedes "build 2.31226.1 is back" in [[the-turn-box-took-the-ghost-text]].

**Why:** he asked for a real fix for the app being slow. The old build's window renderer grew 1.1 → 1.7 GB a day and the RAM meter's idle restart never fired (he is always at the keyboard).

**NVIDIA is a dead end:** the Windows Graphics "High performance" entry for `...\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\app\claude.exe` saves (`GpuPreference=2`) but Claude's GPU process stays on the Intel UHD 630 (LUID `0x12c5f`, the adapter that drives the panel); the RTX 2070 sat at 0 MB. Never recommend it again.

**How to apply:** when he says the app is slow, the measured lever is a quit-from-tray restart (window 792 → 673 MB, renderer 56 → 46% of a core, free RAM +581 MB). Hooks were ruled out (~150 ms each vs 100 ms bare node start); Firefox was the biggest CPU user (1.2 cores).

**The real freeze cause (measured 2026-10-26 ~18:00 Cairo, `~/.claude/scripts/mem-watchdog.log`):** 140 PRESSURE events that day; free RAM bottomed at **92 MB at 16:00** with **Edge at 5-7 GB** (pinned WhatsApp Web app, `--app-url=https://web.whatsapp.com/`, plus tabs, up to 48 processes) as the top holder, then Claude (22-38 processes, 3-9 GB), then dev-server node (up to 5.9 GB, exempt by owner rule). A node process once took 41 GB of virtual memory (System event 2004, 2026-10-23 11:54). Page file is a fixed 64 GB on C:, so it is not the limit. Hooks are ~10-30 ms over a bare node start. Fast mode is unavailable in the app (`sdk_opt_in_required`).
