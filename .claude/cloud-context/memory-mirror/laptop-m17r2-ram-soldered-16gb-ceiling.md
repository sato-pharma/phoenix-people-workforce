---
name: laptop-m17r2-ram-soldered-16gb-ceiling
description: "The laptop is an Alienware m17 R2 with SOLDERED 16GB RAM — no upgrade possible; ≤4 local sessions; guardrails installed 2026-08-01"
metadata: 
  node_type: memory
  type: project
  originSessionId: c8217a8f-ead4-4534-8079-481b0e017f4f
  modified: 2026-09-17T06:35:42.192Z
---

The dev machine is an **Alienware m17 R2** (2019): RAM is **soldered — 16 GB is a permanent
ceiling**. Dell's manual and community threads confirm no SODIMM slots; SMBIOS reporting
"32 GB max" is the memory controller's theoretical number, and `DeviceLocator: System Board
Memory` / `FormFactor: 0` is the soldered signature. One 512 GB NVMe disk split C: (293 GB)
/ F: (41 GB, the repo partition).

**Why:** every "laptop is slow" incident traces to RAM saturation
([[laptop-thrashing-pagefile-feedback-loop]]). The hardware cannot grow, so the fix is
workload shape (cloud-first), never "try harder locally."

**How to apply:**
- Keep **≤4 local Claude Code sessions** (each ≈600 MB with its MCP children); route
  parallel work to cloud sessions on Sonnet per [[parallel-work-model-2026-07]].
  The Agent tool's `isolation: "remote"` is NOT one of them — it ran on this laptop
  ([[agent-isolation-remote-ran-locally-in-a-worktree]]).
- Guardrails BOTH LIVE at user level (2026-08-01): `~/.claude/hooks/statusline.ps1`
  (shows free RAM + session count in every session) and `~/.claude/hooks/memory-guard.ps1`
  (SessionStart hook in user settings.json — warns new sessions when free RAM < 2.5 GB or
  sessions > 4, silent when healthy; verified firing in both states). First wiring attempt
  was classifier-blocked; owner approved in chat and it applied.
- **cloud-run MCP server is intentionally DISABLED** user-level (`disabledMcpjsonServers`
  in `~/.claude/settings.json`): it spawned 2 node processes (~200 MB) per session with
  zero observed usage — the allowlisted `gcloud` CLI covers the same needs. Do NOT
  re-enable it without an owner ask.
- Pagefile is system-managed on C: and once ballooned to 36.5 GB; owner advised to cap it
  (custom 16–24 GB) — a system setting only the owner can change.
