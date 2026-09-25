---
name: laptop-thrashing-pagefile-feedback-loop
description: "Machine-wide slowness on this 16 GB laptop is page-file thrashing from too many concurrent Claude sessions — diagnose with Pages Input/sec, not free RAM"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9bc3bd8d-69af-4796-a9d6-d8f9a750fcb7
  modified: 2026-08-01T02:21:47.322Z
---

On 2026-08-01 "everything is very very slow" was **not** the app, the network, or Claude — the
laptop was thrashing. Measured: 0.54 GB physical free, **44.3 GB commit charge on 15.8 GB RAM**,
and **13,000–18,000 hard page faults/sec**. CPU read 100% but was mostly waiting on disk.
Load was 30 `claude.exe` + 36 `node.exe` (28 of them per-session MCP servers, each session
spawns its own set) across 17 worktrees.

**Why:** there is a feedback loop that makes this self-worsening. RAM exhaustion grows
`C:\pagefile.sys` (found at **36.62 GB allocated**, peak use 13.05 GB) — that single file was
the largest consumer of C:, larger than Docker or Downloads. A fuller C: leaves less room to
page, which worsens the thrashing. Disk cleanup and RAM pressure are the *same problem* here,
not two problems.

**How to apply:**
- Diagnose with `\Memory\Pages Input/sec` (healthy ≈ 0; >10k = thrashing), **not** free physical
  RAM — Windows always keeps RAM full with cache, so "0.5 GB free" is normal and stayed ~0.5 GB
  even after reclaiming 14.5 GB of commit charge. Free RAM is a useless signal on this machine.
- **Take ~20 samples and use the MEDIAN; a 3-sample snapshot is worthless.** Individual readings
  swing 3 → 14,350 on an otherwise healthy box. Two separate single spikes (15,536 then 21,946)
  each looked like a relapse and each was noise: the 24-sample median was 489, with 18/24 under 1k.
- **Attribute load with per-process CPU delta before blaming memory.** Sample `(Get-Process).CPU`
  across an interval: if page faults rise while CPU is high, that is *work*, not starvation.
  Measured 2026-08-01: 3 Claude sessions burned **75.5 CPU-seconds per 15s wall** = ~42% of all
  12 cores, sustained — the elevated faults tracked that, not memory pressure. The same delta
  check identifies which sessions are safe to close: >0.5s per 8s window means mid-task, and
  age is NOT idleness (a 10h-old session was burning 5s/8s).
- Check `Get-CimInstance Win32_PageFileUsage` early — a huge pagefile is the *fingerprint* of
  chronic over-subscription, and it silently eats the OS drive.
- Biggest safe C: reclaim found: `AppData\Roaming\Claude\vm_bundles` was **9.3 GB** (regenerable
  cache; deleted cleanly with 30 sessions live, nothing broke). Docker ~10.7 GB and browser
  profiles ~11.4 GB are the next tier.
- Killing a long-parked dev server reclaims *commit charge*, not resident RAM — after ~32 h idle
  it is fully paged out and shows 0–2 MB working set. Don't judge a process's cost by working set
  when the machine is swapping. Termination of a paged-out process is also slow (it must page
  back in to tear down), so a kill can report "still alive" for several seconds — re-check before
  concluding it failed.
- The real fix is fewer concurrent sessions; see [[parallel-work-model-2026-07]] (2–3 woken
  worktrees, one control tower). Cache deletion only buys headroom.
- Do **not** blanket-clear `%LOCALAPPDATA%\Temp` to reclaim space here — see
  [[localappdata-temp-is-live-tool-state]]. Use `C:\Windows\Temp` instead.

Related: [[dont-foreground-watch-long-pipelines]], [[ai-tool-damage-prevention]]
