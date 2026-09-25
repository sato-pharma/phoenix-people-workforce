---
name: windows-defender-dev-exclusions
description: "Slow/non-responsive localhost on Windows was Defender scanning dev I/O; exclusions added."
metadata: 
  node_type: memory
  type: project
  originSessionId: 73c9add5-2010-47b1-985d-6bf036f2c6aa
---

On 2026-05-31 localhost was effectively non-responsive (page requests timing out 25–90s, dev server flapping). Root cause was **Windows Defender real-time protection scanning every file Turbopack reads/writes** during on-demand compilation of the large app (151 API routes + 86 pages, ~760MB node_modules, ~600MB .next). The F: drive is SSD/RAID — disk was never the bottleneck.

**Fix applied (needs admin/UAC):** `Add-MpPreference` exclusions for the project folder `F:\Phoenix Workforce\phoenix-workforce` (plus `.next`, `node_modules`) and processes `node.exe`, `npm.cmd`. After exclusions + a clean `.next` wipe + a single dev server, warm page responses dropped to ~0.5–0.9s; first-hit-per-route compile ~7.7s (normal Turbopack on-demand cost).

**Why:** Defender scanning dev build I/O is the classic Next.js-on-Windows slowdown.
**How to apply:** If localhost goes slow again, first confirm only ONE dev server is on :3000 (orphaned duplicates flap and cause "unable to connect"), verify the Defender exclusions still exist, and clear `.next` if it was killed mid-compile.
