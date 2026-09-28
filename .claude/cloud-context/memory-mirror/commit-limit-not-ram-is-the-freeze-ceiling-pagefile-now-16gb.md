---
name: commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb
description: "Diagnosing a hard freeze or BSOD on this laptop: it is ALWAYS memory starvation, in two shapes with opposite signatures. A commit-limit hang leaves NO dump (empty C:\\Windows\\Minidump is EXPECTED, only Kernel-Power 41) - tell is dwm.exe dying with 0xc00001ad/0xc000012d (both STATUS_COMMITMENT_LIMIT) + System.OutOfMemoryException minutes before, and Event 2004's <CommitCharge> naming a node.exe that spiked 12-22GB in under a minute. Physical-RAM starvation CAN bluescreen through the GPU stack WITH a dump (0x116/nvlddmkm, 0x9F, 0x10E) while COMMIT reads green ~33% - so a minidump and an NVIDIA/Intel driver code do NOT rule out memory; read free PHYSICAL RAM at the crash time, not commit. The runaway dies with the freeze, so sampling live processes after a reboot clears nobody. Current machine state (16GB non-soldered, 32GB-capable; pagefile fixed 64GB ~80GB commit; heavy-job gate RETIRED 2026-09-17; mem-watchdog reaps) is authoritative in ~/.claude/CLAUDE.md + AGENTS.md 5 - the pagefile-pin, gate and watchdog-rule history this file once held is SUPERSEDED."
metadata: 
  node_type: memory
  type: project
  originSessionId: b974beb4-54ef-40e3-a9b5-e4abda597572
  modified: 2026-09-25T22:40:44.940Z
---

**A hard freeze or BSOD on this laptop is memory starvation, every time.** It comes in two shapes
with opposite tells — learn to name which one from the event log, and never chase the decoys.

## Shape 1 — commit-limit hang (leaves NO dump)

- **No bugcheck, no minidump — only `Kernel-Power 41`.** An empty `C:\Windows\Minidump` is the
  *expected* signature, not a hardware clue. Hardware reads clean (zero WHEA, NVMe Healthy).
- **The tell to grep for first:** `dwm.exe` crashing with exception **`0xc00001ad`** or
  **`0xc000012d`** — both are `STATUS_COMMITMENT_LIMIT` — with `System.OutOfMemoryException` in the
  Application log in the same window, minutes before the freeze. `Application Popup 26` (dwm
  `0xc000012d`) is the cheapest single freeze counter.
- **Event 2004's field is literally `<CommitCharge>`, not reservation.** It names the runaway —
  almost always a freshly-launched `node.exe` that reached **12–22 GB in under a minute**. One was
  caught twice climbing 7.2→18 GB in 38 s (~280 MB/s).
- **The runaway dies with the freeze.** Sampling live `node.exe` after a reboot finds only the
  innocent survivors (~34 MB). Never exonerate a process by what's alive afterward.

## Shape 2 — physical-RAM starvation (CAN bluescreen WITH a dump)

- Bluescreens through the **graphics/driver stack** — `0x116` VIDEO_TDR_FAILURE (Windows names
  `nvlddmkm.sys`), `0x9F`, `0x10E` — **while COMMIT reads green (~33%)** and free *physical* RAM hits
  bottom (measured 43–168 MB before two 09-11 crashes).
- **So a minidump and an NVIDIA/Intel driver code do NOT rule out memory.** Read free **physical
  RAM** around the crash time, not commit. This is the two-ceilings trap in AGENTS.md §5: **free RAM
  is what binds, not the commit charge.**

## Decoys — all downstream, do not chase

- **NVIDIA/Intel TDR bursts** (`nvlddmkm` Event 14) sit *inside* the dwm cascade; updating the stale
  drivers fixes nothing while memory is the ceiling.
- **`SleepInProgress = 1` in the Event 41 payload** is the idle sleep timer firing on an
  already-wedged box, not an S3 bug.
- **DISM's 1309 `CSI FileFlags`** are benign attribute mismatches — the component store is a dead
  end. DISM/SFC were run and came back clean; **do not run them again for a freeze.**
- **`VirtualSize` is address-space reservation, not memory** (one msedge read 3,621 GB VirtualSize
  vs 503 MB commit). Judge by commit / free RAM, never VirtualSize.
- **`Kernel-Power 41` is written on the NEXT boot.** Read *past* the boot block (HAL 16, Kernel-Boot
  30) to the last event before it, or every freeze looks causeless.

## Current machine state lives elsewhere — this file no longer tracks it

The live figures — **16 GB RAM (2×8 GB, NOT soldered; Alienware m17 R2, 32 GB-capable), pagefile
fixed at 64 GB so commit limit ≈ 80 GB, the heavy-job gate RETIRED 2026-09-17, and `mem-watchdog.ps1`
reaping node jobs under the RAM floors** — are authoritative in `~/.claude/CLAUDE.md` and AGENTS.md
§5. The long pagefile-pinning saga, the heavy-job gate/queue and the individual watchdog rules this
file once carried are **superseded**; do not quote a commit-limit number from memory — measure free
physical RAM live. Related: [[turbopack-500s-with-0xc0000142-when-commit-is-full]].
