---
name: laptop-m17r2-ram-soldered-16gb-ceiling
description: "The laptop is an Alienware m17 R2 with 16GB RAM in TWO SODIMM slots — NOT soldered, 32GB-capable (2×16GB DDR4-2666 is a hardware fix); pagefile fixed 64GB (~80GB commit); until the upgrade run LEAN, cloud-first. Authoritative figures live in ~/.claude/CLAUDE.md + AGENTS.md §5"
metadata: 
  node_type: memory
  type: project
  originSessionId: c8217a8f-ead4-4534-8079-481b0e017f4f
  modified: 2026-10-02T16:35:36.011Z
---

The dev machine is an **Alienware m17 R2** (2019) with **16 GB RAM (2×8 GB SK Hynix DDR4-2666) in
two SODIMM slots — NOT soldered, max 32 GB** (SMBIOS: 2 memory devices, MaxCapacity 32 GB). So the
RAM ceiling is a hardware fix: 2×16 GB DDR4-2666 SODIMM reaches 32 GB. One 512 GB NVMe disk split C:
(293 GB) / F: (41 GB, the repo partition).
**Superseded 2026-10-02:** previously "RAM is soldered — 16 GB is a permanent ceiling; SMBIOS
'32 GB max' is only the controller's theoretical number" — corrected 2026-09-24 in
`~/.claude/CLAUDE.md` ("This machine"), which is authoritative.

**Why:** every "laptop is slow" incident traces to RAM saturation
([[laptop-thrashing-pagefile-feedback-loop]]). Until the 32 GB upgrade lands, the fix is workload
shape (cloud-first), never "try harder locally."

**How to apply:**
- **Run this box LEAN by default** (owner rule 2026-09-24, `~/.claude/CLAUDE.md`): route every
  independent or heavy task to a cloud session; local sessions only for a browser look, a dev-auth
  role sweep, or local creds/files (AGENTS.md §5 routing rule), per [[parallel-work-model-2026-07]].
  Free RAM is what binds — read it live, never a fixed session count.
  The Agent tool's `isolation: "remote"` is NOT a cloud session — it ran on this laptop
  ([[agent-isolation-remote-ran-locally-in-a-worktree]]).
  **Superseded 2026-10-02:** previously "keep ≤4 local Claude Code sessions" — the fixed cap was
  dropped when the pagefile grew (memory-guard rewrite 2026-08-25, PR #2409), and the LEAN rule of
  2026-09-24 replaced it.
- Guardrails at user level: `~/.claude/hooks/statusline.mjs` (free RAM, commit, session count and
  session age in every session) and `~/.claude/hooks/memory-guard.mjs` (SessionStart hook in user settings.json) — Node
  rewrites of the 2026-08-01 `statusline.ps1` / `memory-guard.ps1`, whose old "free RAM < 2.5 GB or
  sessions > 4" warning was retired 2026-08-25; read the hook for its current threshold. First
  wiring attempt (2026-08-01) was classifier-blocked; owner approved in chat and it applied.
- **cloud-run MCP server** was intentionally disabled user-level (it spawned 2 node processes,
  ~200 MB, per session with zero observed usage). It no longer appears in `.mcp.json` or
  `~/.claude.json` at all, and GCP is dead (AGENTS.md §3). Do NOT re-add it without an owner ask.
- **Pagefile is FIXED at 64 GB, so the commit limit is about 80 GB** (measured 2026-09-17,
  `~/.claude/CLAUDE.md`). Commit headroom stays green while physical RAM runs out — free physical
  RAM under ~1.8 GB is the freeze line.
  **Superseded 2026-10-02:** previously "pagefile is system-managed on C:, once ballooned to
  36.5 GB; owner advised to cap it at 16–24 GB" — it was fixed at 16 GB on 2026-08-25 and is now a
  fixed 64 GB (see [[commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb]]).
