---
name: perf-audit-2026-10-03-ram-is-the-bottleneck-and-two-fixes-that-are-not-safe
description: "3 Oct 2026 full performance audit: physical RAM exhaustion (not CPU) is the bottleneck — 233 pressure events + 14 critical, low 141 MB, 10-45k hard pages/sec, CPU only 3.45 of 12 cores sustained. Applied: Expo+Cloudflare plugins off, status line 10→30 s, archiver BelowNormal + hook sweep gap 10→30 min. Deliberately NOT done: turning off watchdog rule 0 (owner-tuned 25 Sep; my 'net +13 MB' churn figure was confounded) and a hook dispatcher (a worker-thread one hands every guard an EMPTY payload, so every guard fails OPEN — tested)."
metadata:
  node_type: memory
  type: project
  originSessionId: 90a45ecd-5f85-41c7-878a-799aca8c2a64
  modified: 2026-10-03T17:38:20.373Z
---

Found and applied 2026-10-03 (Cairo evening), after he asked for a full audit and then said "NXT" to the fix pack.

**The bottleneck.** `mem-watchdog.log` window 10:13-16:45 Cairo: 219 PRESSURE + 14 CRITICAL events, lowest 141 MB free (15:27), every hour under 500 MB at some point. A 6 s counter sample read 10-45k hard pages/sec with the disk 26-60% idle. Sustained CPU was 3.45 of 12 cores. Holders at pressure: node avg 4.2 GB (peak 6.2 GB, a local webpack dev server), Claude 3.8 GB, Edge 1.4 GB (43 tabs), Firefox. Stopping one 2.6 GB dev server took free RAM 1,383 -> 3,615 MB at once.

**Applied (backups `~/.claude/backups/hook-backups/*.pre-2026-10-03-perf`).** `settings.json`: `expo@claude-plugins-official` and `cloudflare@cloudflare` false (38 skill descriptions in every prompt, and two MCP servers that fail auth at every start), `statusLine.refreshInterval` 10 -> 30. `scratchpad-archive.mjs` main block sets BelowNormal (children inherit it on Windows, verified: child priority 10) — the pre-delete sweep imports it in-process so a delete never waits behind it. `scratchpad-guard.mjs` `FULL_EVERY_MS` 10 -> 30 min.

**Why two proposed fixes were NOT applied — do not redo them blind.**
- *Watchdog rule 0 (working-set trim).* It trims only idle non-Claude, non-dev-server processes, it has a yield backoff, and he raised its floor on 25 Sep to cure a real crawl. My "median freed 152 MB but net available gain 13 MB, so it is churn" was confounded: trimmed pages land on the standby/modified lists and other allocations move the figure inside the same seconds. Not evidence of harm. Turning it off would also need a restart of a running watchdog.
- *One hook dispatcher.* Per Bash call 9 node processes fire (3 user + 6 project): ~1.3 CPU-s, 240-300 ms wall, bare node 111 ms under load. Real but second-order next to RAM. A dispatcher that runs the guards in `Worker` threads FAILS OPEN: each guard does `fs.readFileSync(0)` at its top level, the dispatcher has already drained fd 0, and the worker reads `""` — tested 3 Oct, a guard parsing it sees no command and allows. A real dispatcher means refactoring the guards into exported `check(input)` functions (trap-injector, session-lock, mobile-freeze-guard and bash-guard's 5 `process.exit` paths are not import-safe), each pinned by its own test, with a risk review. `if` on a hook entry is documented but its event scope and minimum version are not, so it cannot yet be relied on to narrow a guard.

**How to apply:** a slowness audit starts from free RAM and the watchdog log, not the hooks. Never gate a guard with a pattern copy that can drift from the guard itself. See [[slowness-audits-compare-before-and-after]].
