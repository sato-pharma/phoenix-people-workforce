---
name: commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb
description: "2026-09-11: memory starvation ALSO BLUESCREENS through the graphics stack (0x116 nvlddmkm, 0x9F, 0x10E) - a minidump does NOT rule memory out; read free PHYSICAL RAM, not commit. The laptop hard freezes are Windows COMMIT-limit exhaustion. The 2026-08-26 in-place reinstall wiped the pagefile fix and the box froze again at 11:13; it was re-pinned to 32768/65536 MB and is LIVE. That pin is a RANGE, so the limit is RAM + the pagefile as currently ALLOCATED and it FLOATS: 47.79 GB is the FLOOR, ~79.79 GB fully grown. A HIGHER reading is ordinary growth (that is the unexplained 53.83); only a reading BELOW 47.79 means the pagefile was reset AGAIN. Growth does not save you - a spike still hit 99.7%. 2026-09-12: heavy-work package live - heavy-job gate hook (per-job RAM need 5000/4500/2600 MB, 90 s stagger, 10 min pause after a watchdog pressure kill), heavy-queue, watchdog rules 7-9."
metadata: 
  node_type: memory
  type: project
  originSessionId: b974beb4-54ef-40e3-a9b5-e4abda597572
  modified: 2026-09-21T07:53:24.339Z
---

> ## STATE AS OF 2026-08-26 - RE-PINNED AND **LIVE** (verified after the 15:14 reboot)
>
> Windows was **reinstalled in place at 06:19 Cairo on 2026-08-26**; the reinstall **reset the
> pagefile to system-managed**, discarding the fixed size this file is about, and the box **froze
> again at ~11:13 the same morning.**
>
> The owner re-pinned it the same afternoon and it is **verified written but NOT YET IN EFFECT** -
> a pagefile change needs a restart. Confirm which side of the reboot you are on before trusting
> anything below:
>
> - `(Get-CimInstance Win32_OperatingSystem).TotalVirtualMemorySize*1KB/1GB`
>   - reads **~37.4** -> the OLD limit; the pagefile was reset again and the box can freeze
>   - reads **~47.8** -> correct, this is the fixed state
>
> **Measured 15:17 Cairo, 3 min after the reboot: limit 47.79 GB, used 8.88 GB (19%),
> free 38.91 GB, pagefile 32,768 MB allocated.** If a later session reads ~37.4, the pagefile
> was reset (a Windows feature update or in-place repair does this) - re-pin it, do not
> re-diagnose from scratch.

**The ceiling that matters on this machine is the Windows COMMIT limit, not installed RAM.**
RAM is soldered at 15.79 GB and cannot be upgraded, but commit limit = RAM + pagefile, and the
pagefile is the half that was fixable.

## What changed 2026-08-25

Measured live after the 14:14 Cairo boot:

| | before | 2026-08-25 | **2026-08-26 (live)** |
| --- | --- | --- | --- |
| Pagefile | ~4 GB | 16384 MB fixed | **32768 MB initial / 65536 MB max** |
| Commit limit | ~19.79 GB | 31.79 GB | **47.79 GB** |
| Commit free, under normal load | ~2 GB | 21.56 GB | **26.77 GB** |

**The pagefile moved TWICE in two days, which is the whole reason this file says read it live.** The
filename still says 16GB and the 31.79 GB figure was already stale within 24 hours. **Never quote a
commit limit from this note — measure it.** The numbers here are dated illustrations of the
mechanism, not current state.

With 14 `claude.exe` running, commit in use was 10.23 GB against the new 31.79 GB limit. The same
pressure spike that used to kill the box recurred at 14:10–14:16 that day — four `dwm.exe` crashes
and an `OutOfMemoryException` — and **the machine survived it.**

> **Correction, verified 2026-08-26.** It did not survive that one. Those four `dwm.exe` crashes
> (14:10:25, 14:10:57, 14:11:14, 14:11:49) *preceded* the freeze whose boot is stamped **14:14:59** —
> they caused it, they did not ride it out. The fix landed after that boot. Read a `dwm` crash
> cluster as the freeze it precedes, never as one the box absorbed.

## Did the fix hold? Measured 2026-08-26 ~00:45 Cairo

**Mostly, and the evidence is a clean absence.** Counting from the fix to ~10 hours later:

| Signal | Before the fix (08-25) | Since the fix |
| --- | --- | --- |
| `dwm.exe` crash, `0xc00001ad` | ~14 across 08-21→08-25 | **0** |
| `System.OutOfMemoryException` | repeated cascades | **0** |
| Event 2004 low-virtual-memory | 4 on 08-25 alone | **0** |
| Hard freezes | **6** in the 12h before | **1** |

The last event of any kind is 14:13:11 on 08-25. The box has since held a **2-hour S3 sleep and a
clean resume**, and sat at **40% commit (12.75 of 31.79 GB) with 15 `claude.exe` live**.

**The one post-fix freeze (boot 20:49:09, 08-25) logged nothing at all** — no 2004, no `dwm` crash,
no OOM. That is consistent with the 85%-threshold reasoning already in this file: a spike steep
enough wedges the box before it can write the warning. So **the ceiling was raised, the appetite was
not.** Headroom, not immunity.

**What actually fills it is breadth, re-confirmed live:** `claude` ×15 = 2,984 MB, `ChatGPT Classic`
×8 = 1,095 MB, `msedge` ×14 = 999 MB, Defender 426 MB, `svchost` ×88 = 405 MB. All processes
together commit 8.97 GB of the 12.75 GB charged; the ~3.8 GB balance is kernel and driver commit,
which no process list will ever show you. Closing the idle ChatGPT and Edge windows is the cheapest
~2 GB of headroom available. `C:` had 92.4 GB free, so a further pagefile raise is affordable.

**The Event 2004 process names are STILL reservation, exactly as this file already warned** — the
2026-08-26 pass re-checked rather than re-trusting. Every 2004 blames `node.exe` at 13.6 / 16.8 /
20.1 / 23.9 GB. Live at the time of writing, the only 4 node processes were all
`openai-bridge/server.mjs` at **35 MB commit against 5.2 GB reserved each**, and one `msedge` sat at
**505 MB commit against 3,621 GB reserved**. Do not re-accuse `node`; that accusation has now been
raised and withdrawn twice.

## Why the old diagnosis kept going wrong

- **No crash dump does NOT rule out memory.** A commit-limit hang produces no bugcheck and no
  minidump — only `Kernel-Power 41`. An empty `C:\Windows\Minidump` is the *expected* signature
  here, not evidence of a hardware fault. Hardware was clean throughout: zero WHEA events, NVMe
  Healthy, no disk/NTFS errors.
- **The NVIDIA driver errors are a SYMPTOM — do not chase them.** Re-investigated 2026-08-26 and
  this trap caught that session too, for several tool calls. The System log holds an `nvlddmkm`
  burst — 18 errors at 14:13:07 on 08-25, Event 14 on `\Device\Video7`, payload
  `CMDre … ff1fe141` — **112 seconds before** a freeze, which reads like a perfect causal chain.
  It is not. That burst sits *inside* the `dwm.exe` crash cascade of 14:10:20–14:14: the compositor
  died five times with `0xc00001ad` and took the display stack down with it. **`dwm.exe` crashing
  with exception code `0xc00001ad` IS `STATUS_COMMITMENT_LIMIT`** — that single code is the whole
  diagnosis, and it is the thing to grep for first. Two further decoys sit beside it and are both
  real but irrelevant: the Intel UHD 630 panel driver is `27.20.100.9664` dated **2021-06-01**
  (five years stale, and it — not the RTX 2070 — drives the display; the NVIDIA card is
  Optimus render-only), and NVIDIA is `552.12` dated 2024-04-02. Updating either fixes nothing
  while commit is the ceiling. GPU was 47 °C with HW Thermal Slowdown "Not Active".
- **`SleepInProgress = 1` in the Event 41 payload is also downstream.** It appeared on 6 of the 7
  freezes and looks like an S3-resume bug (the box is S3-only, hibernation off, yet
  `HiberbootEnabled = 1` with no `hiberfil.sys` — a real inconsistency, but not this one).
  The mundane reading fits every case: commit exhaustion wedges the box, the owner cannot interact,
  the 30-min idle sleep timer fires anyway, and the transition never completes.
- **The real tell is `dwm.exe` dying with `0xC00001AD` (`STATUS_COMMITMENT_LIMIT`)**, minutes before
  each freeze, with `System.OutOfMemoryException` in the Application log in the same window.
- **`VirtualSize` is address-space RESERVATION, not memory in use** — and it is wildly misleading on
  this box. Live sample: one `msedge.exe` reported **3,621 GB** VirtualSize against **503 MB** of
  real commit; `claude.exe` ~3,500 GB against ~330 MB. A "12–22 GB node process" read off event 2004
  or a VirtualSize column is very likely reservation. **Judge by commit, never by VirtualSize.**
- **The driver is BREADTH, not one process.** 14–15 concurrent `claude.exe` plus ~13 node helpers
  (openai-bridge, Supabase MCP) plus Excel, Edge, ChatGPT and Defender. A process listing taken two
  minutes before the first freeze showed **all 13 node processes small** — no giant one existed.

`node scripts/repo-doctor.mjs` was accused of being the trigger in 3 of 5 freezes and then
**withdrawn** by the session that raised it, on both points above. It is fine to run normally; the
only real caution is not to run it from several sessions at once, since it walks ~1.9M paths.

## What this supersedes

**`AGENTS.md` §5 said "Keep total local sessions at 4 or fewer" and the SessionStart guard warns at
~4 — both were written against the old ~19.79 GB limit and are conservative by roughly 12 GB.**
`AGENTS.md` was corrected in PR #2409 (branch `codex/agents-commit-ceiling`, worktree
`../_wt-agents-commit-ceiling`), which rewrites §5 to watch **headroom** rather than a session count
and adds the diagnosis to §2.1.

**The harness guard was fixed the same day** (owner's instruction, "fix the ram guard"). All three
now trigger on **commit >= 85%** — one threshold, not three — and consult free RAM only when commit
cannot be read at all:

| File | Was | Now |
| --- | --- | --- |
| `~/.claude/hooks/memory-guard.mjs` | `os.freemem() < 2.5 GB` OR `> 4` sessions | commit `>= 85%`; RAM only as a fallback below 1 GB |
| `~/.claude/scripts/ram-guard.ps1` | `$LowFreeRamGB = 2.5` OR `$MaxHealthySessions = 4` | `$CommitWarnPct = 85`; logs commit as "the ceiling" |
| `~/.claude/hooks/statusline.mjs` | flagged `SATURATED` under 2.5 GB free RAM | that arm fires only when commit is unreadable |

85 rather than 100 because the freeze happens during an allocation **spike** — at 100% the box is
already wedged and cannot even render the warning. Verified against today's real readings: the old
rule fired at 10 and 14 sessions when commit was 42% and 32% (both false alarms, now silent), while
a genuine 97% pre-freeze still trips. Both `memory-guard.mjs` and `ram-guard.ps1` read commit from a
`Get-CimInstance Win32_OperatingSystem` call they were **already making**, so the fix costs no extra
subprocess. The two hooks keep separate cache files on purpose — sharing one made the statusline's
commit segment blank for 20s after every SessionStart.

**Re-read the live commit figures before repeating any session-count number to the owner** —
`Win32_OperatingSystem.TotalVirtualMemorySize` is the limit and `FreeVirtualMemory` the headroom,
both in KB.

Symptoms seen while the OLD limit was in force, all of which are commit exhaustion and none of which
mean the work was wrong: bash `fork: retry: Resource temporarily unavailable` with
`0xC000012D`, PowerShell refusing to start with *"Could not load file or assembly
System.Management.Automation … The paging file is too small"*, `gh` returning *"Resource temporarily
unavailable"*, and a heredoc silently failing to create its script so the next command dies with
`MODULE_NOT_FOUND`. Check the shell is alive with `echo alive` before blaming the task. Related:
[[turbopack-500s-with-0xc0000142-when-commit-is-full]] is the same ceiling seen from the dev server.

## Correction — the "0 since the fix" row expired 36 minutes after it was written

Measured 2026-08-26 02:11 Cairo, uptime 5.4h from the 20:49:09 boot. The table above says
`dwm.exe 0xc00001ad` = **0** since the fix; it was measured at ~00:45 and **four more landed at
01:21:00, 01:23:49, 01:24:40 and 01:25:02**, with a matching **Event 2004** at 01:21:49. Faulting
modules `dwmcore.dll` (+0x1a0bd8) and `udwm.dll` (+0x86d48), same exception code. So the 16 GB
pagefile **did not end them.**

**But the severity changed, and that is the real finding.** All four were survivable: `dwm`
restarted itself, the session held, and there has been **no hard freeze since 20:49** — the box is
still up 5.4h later. Before the fix a `dwm` cluster *was* the freeze. After it, a cluster is a
black flicker you can work through. Read a post-fix `dwm` burst as a warning shot, not a crash.

**Commit charge and pagefile bytes disagree, and both readings are correct.** At the moment of the
burst the pagefile had peaked at only **1.65 GB of 16 GB** since boot, yet commit hit the ceiling.
That is not a contradiction: committed-but-never-touched pages are charged against the commit limit
in full while occupying neither RAM nor pagefile. **So an empty pagefile is not evidence of commit
headroom** — read `\Memory\Committed Bytes` against `\Memory\Commit Limit`, never pagefile usage.

**~~Event 2004 blamed `node.exe` (PID 14928) at 20.8 GB — reservation again, for the third time.~~**
~~The one live `node.exe` at the time of writing sat at 5.16 GB virtual against 34 MB commit.
Do not re-accuse node.~~

> **WRONG — struck 2026-08-26. See "OVERTURNED" below, which settles it from the raw event XML:
> the field is literally `<CommitCharge>` and `node.exe` WAS the culprit.** The reasoning above is
> the exact trap that section describes: PID 14928 was already dead, so the surviving node
> processes I sampled were the innocent ones. Sampling survivors clears nothing — the process that
> exhausts commit dies with the freeze it causes.

**The pagefile is SYSTEM-MANAGED, not fixed.** `Win32_PageFileSetting` returns **no rows** and
`Win32_ComputerSystem.AutomaticManagedPagefile` is **True** — so the table above calling it
"16384 MB fixed (`InitialSize` = `MaximumSize`)" is wrong; Windows sized it to 16 GB on its own. A
system-managed file **grows on demand and the growth lags a fast allocation spike**, which is
exactly the failure mode here. Setting a fixed `Initial = Maximum = 32768 MB` removes the lag;
`C:` had **92.8 GB free**, so it is affordable.

## Windows itself is NOT damaged — do not run DISM or SFC again for this

`C:\Windows\Logs\CBS\CBS.log`, read 2026-08-26 (11.7 MB, sessions through 02:07:46):

| Check | When | Result |
| --- | --- | --- |
| DISM `/ScanHealth` | 01:31–01:33 | `numCorruptions = 0`, every category 0, `S_OK` |
| DISM `/RestoreHealth` | 01:34–01:52 | Detected **1309**, repaired **1309** — *all* `CSI FileFlags`, `S_OK`, no reboot |
| `sfc /scannow` | 02:03:55–02:05:44 | 167 verify batches, **"Repairing 0 components"**, zero `Cannot repair` |

`, Error ` appears **0** times in the whole file; the 10 `, Warning ` lines are all
`WatsonHelper: File already set`, which is noise.

**The 1309 are benign and the number is alarming for no reason.** `CSI FileFlags` corruption is a
file-*attribute* mismatch on component-store files — not payload, not manifest, not metadata, all of
which read 0. It is a routine finding on Windows 11 24H2 (build 26100) and **cannot** crash a
compositor. Note the tell: `ScanHealth` reported 0 while `RestoreHealth` fixed 1309 — the detect
pass does not look at staged file flags, so that gap is expected and is not a sign of a scan lying.

**Conclusion: component-store integrity is a dead end for the freezes.** If a future session sees
`dwm` dying and reaches for DISM/SFC, it has already been done and came back clean — go straight to
`\Memory\Committed Bytes` instead.

## OVERTURNED 2026-08-26 03:30 — Event 2004 reports COMMIT. `node.exe` was the culprit all along.

This file says three times "do not re-accuse node; the 2004 figures are RESERVATION", and the
`MEMORY.md` hook line said it too. **That is wrong, and it was wrong each time.** Settled by reading
the raw event XML instead of reasoning about it — the schema is
`Microsoft-Windows-Resource-Exhaustion-Detector/MemoryExhaustionInfo`:

```xml
<Process_1><Name>node.exe</Name><ID>3604</ID>
  <CreationTime>2026-08-25T23:23:25.1856991Z</CreationTime>
  <CommitCharge>23505555456</CommitCharge>          <!-- 21.89 GB -->
  <Version>24.15.0.0</Version></Process_1>
```

**The field is literally `<CommitCharge>`.** Three independent confirmations:

1. The element name. There is no VirtualSize field in this schema at all.
2. **The same events report `claude.exe` at 0.90 GB and `msedge.exe` at 0.64 GB.** This file records
   those two processes at ~3,500 GB and ~3,621 GB *VirtualSize*. Had 2004 printed reservation they
   would read in the thousands of GB. They do not — so 2004 is not printing reservation.
3. `SystemCommitCharge` = 33,872,879,616 (31.55 GB) against `SystemCommitLimit` = 34,139,250,688
   (31.79 GB) in the same block — **99.2%**, and those two are indisputably commit.

**Why the withdrawal kept looking right.** Every earlier check sampled live `node.exe` processes
*after* a reboot and found `openai-bridge/server.mjs` at ~34 MB. Of course it did — **the runaway
process dies with the freeze.** You cannot find it afterwards. Sampling survivors and concluding the
dead one was innocent is the whole error. The reservation theory was invented to explain a gap that
only existed because the evidence had been power-cycled away.

### What the 81 Event 2004s in 3 days actually show

Nine of them name a **freshly launched** `node.exe` (Node **24.15.0**) that reached a huge commit in
seconds — this is a runaway allocation, not the gradual "breadth" this file argued for:

| Fired | PID | node commit | Process age |
| --- | --- | --- | --- |
| 08-26 02:23:45 | 3604 | **21.89 GB** | 19 s |
| 08-26 01:21:49 | 14928 | 20.80 GB | 14 s |
| 08-25 14:09:57 | 7700 | 18.75 GB | 15 s |
| 08-25 13:59:43 | 28732 | 12.71 GB | 13 s |
| 08-25 11:18:26 | 18652 | 15.68 GB | 31 s |
| 08-25 03:03:22 | 18104 | 22.26 GB | 17 s |
| 08-25 02:35:17 | 18184 | **22.30 GB** | 17 s |
| 08-25 02:26:49 | 24236 | 17.98 GB | 46 s |
| 08-25 02:26:14 | 24236 | 7.24 GB | 8 s |

**PID 24236 is caught twice on the way up — 7.24 GB at 8 s, 17.98 GB at 46 s. It grew 10.7 GB in 38
seconds (~280 MB/s).** That is the growth curve, recorded live, and it ends the argument.

The remaining ~70 events name `claude.exe` at 0.9–1.3 GB with process ages of 12,000–110,000 s
(hours to days). Those are **not** a runaway — they are simply the largest survivor at a moment when
the box was already pinned. Which is the other half of the truth: `SystemCommitCharge` reads
**31.54–31.79 GB against a 31.79 GB limit in every single one of the 81 rows.** The machine sat at
~99% commit for days. So both readings hold, and this file was half right:

- **Baseline** — breadth kept the box pinned at 99%. Real, and this file documented it correctly.
- **Trigger** — a node process taking 12–22 GB in under a minute is what tipped 99% into a hang.

Breadth alone never produced a freeze; every hard-down has a node spike beside it.

### The freeze chain, end to end (08-26, from the System + Application logs)

| Cairo | Event |
| --- | --- |
| 02:23:25 | `node.exe` (PID 3604) starts |
| 02:23:44 | commit hits 31.55 / 31.79 GB — **99.2%**; node holds 21.89 GB of it |
| 02:23:45 | Event 2004 low-virtual-memory |
| 02:24:11 | `dwm.exe` crash |
| 02:24:53 | `dwm.exe` crash |
| 02:25:56 | **`Application Popup 26`: dwm.exe — `0xc000012d`** = `STATUS_COMMITMENT_LIMIT` |
| — | black screen; owner power-cycles |
| 02:29:02 | boot; `Kernel-Power 41` + `EventLog 6008` written retrospectively |

**`0xc000012d` names the cause in the error code.** Note it is *not* the `0xc00001ad` this file tells
you to grep for — grep **both**. `Application Popup 26` is the cheapest single counter of freezes:
26 of them across 08-11 → 08-26.

Also: **Event 41 is written on the NEXT boot, not at the hang.** The events adjacent to it in the log
are the boot sequence (`HAL 16`, `Kernel-Boot 30`, `Kernel-General 20`). To find the real cause, read
*past* the boot block to the last event before it. Misreading this makes every freeze look causeless.

### Hard-downs did NOT stop with the 16 GB pagefile — 4 more followed it

`Kernel-Power 41` / `EventLog 6008`, 10 in 15 days, agreeing exactly:
08-11 18:05:53, 18:29:16 · 08-25 02:30:18, 02:39:19, 03:05:57, 11:21:14, 14:05:27, 14:14:59,
20:49:09 · 08-26 02:29:05. **Eight in the final 48 hours.** Only the two on 08-11 produced a
bugcheck (`0x13a KERNEL_MODE_HEAP_CORRUPTION`, minidump `081126-16812-01.dmp`); the eight recent ones
wrote **no dump at all**, which is the expected signature of a commit hang.

### Live state after the 03:15:19 boot on 08-26

Pagefile is **system-managed, 28,023 MB allocated → commit limit 43.16 GB** (up from 31.79). The
`AGENTS.md`/`MEMORY.md` line "Pagefile 16GB since 08-25" is stale; `Win32_PageFileSetting` still
returns **no rows**, so it is managed, not fixed.

Since that boot: `dwm.exe` crashes **0**, Event 2004 **0**, `Kernel-Power 41` **0**, commit
**11.24 / 43.16 GB (26%)**. Arithmetic on the worst case observed: 11.2 GB baseline + a 22.3 GB
spike = 33.5 GB, which now **fits under 43.16 GB with ~9.7 GB spare** — where before it overshot
31.79 by ~1.7 GB. That is why the headroom genuinely covers the observed worst case now.

### The actual fix

Raising commit buys headroom; it does not stop a process allocating 22 GB in 19 seconds. **`NODE_OPTIONS`
is unset** (verified). Setting `NODE_OPTIONS=--max-old-space-size=4096` turns a machine-killing freeze
into one command dying with "JavaScript heap out of memory". Honest caveat: that caps the **V8 JS heap
only** — native allocations (Turbopack's Rust side, `sharp`, off-heap buffers) are not covered, so it
is a strong mitigation, not a guarantee.

**Which node script it is remains unidentified** — the process dies with the freeze, so it was never
captured. Candidates that run node here: `next dev --turbopack`, `next build`, `tsc --noEmit`,
`tests/run-tests.ts`, and `scripts/repo-doctor.mjs` (walks ~1.9M paths). Do not repeat the earlier
mistake in reverse: this is a named suspect list, not a verdict. To catch it, log
`Get-Process node | Select Id,PagedMemorySize64,StartTime` on a timer during a work session.

---

## 2026-08-26 - the reinstall wiped it, and it froze the same morning

The in-place reinstall (InstallDate 06:19 Cairo, boots 06:16 / 06:17) restored the profile, the
repo, every credential and every tool - **and reverted the pagefile.** The registry value
`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PagingFiles` reads
`?:\pagefile.sys`, which is the system-managed marker; the 08-25 fix had written an explicit
`C:\pagefile.sys 16384 16384`. `Win32_ComputerSystem.AutomaticManagedPagefile` is `True` again.

**The freeze that followed, straight from the event log:**

| Cairo time | Event | What it says |
| --- | --- | --- |
| 11:10:28 | System 2004 | low virtual memory - **`node.exe (12300) consumed 39,653,724,160 bytes = 36.9 GB** |
| 11:11:26 | App 1000 | `dwm.exe` faulted, exception **`0xc00001ad`** = `STATUS_COMMITMENT_LIMIT` |
| 11:13:05 | System 41 | Kernel-Power - rebooted without cleanly shutting down |
| 11:13:17 | System 6008 | previous shutdown at 10:57:41 was unexpected |

Same signature as every earlier freeze, so the diagnosis in this file is confirmed a third time -
**one node.exe, not RAM, not the GPU.** Note 6008 names 10:57:41 while 2004 and the `dwm` crash are
stamped 11:10-11:11: the dirty-shutdown timestamp is the last clock-tick written before the box
wedged, so it reads EARLIER than events the dying system still managed to log. Do not read that as
two separate incidents.

**Reactive growth is why a system-managed pagefile is not a fix.** It grows only under pressure, so
a fresh install starts small and a steep spike wedges the machine before the file can extend. By the
time this was measured (13:5x, hours after the freeze) it had grown to **22,109 MB / commit limit
37.39 GB** - comfortable, but only because the freeze had already happened. A **fixed** minimum puts
the headroom in place before the spike instead of after it.

**Re-pin it with an ELEVATED PowerShell** (the 08-26 session measured but could not act -
`IsInRole(Administrator)` was **False**, and a pagefile change is a system setting):

    $cs = Get-CimInstance Win32_ComputerSystem
    $cs.AutomaticManagedPagefile = $false
    Set-CimInstance -InputObject $cs
    $pf = Get-CimInstance Win32_PageFileSetting
    $pf.InitialSize = 32768; $pf.MaximumSize = 65536
    Set-CimInstance -InputObject $pf

Then **reboot** - a pagefile change does not take effect until restart - and confirm with
`(Get-CimInstance Win32_OperatingSystem).TotalVirtualMemorySize*1KB/1GB`, which should read ~47.8 GB
minimum instead of 37.39. `C:` had **83.4 GB free**, so a 64 GB maximum is affordable.

**Cheapest headroom that needs no elevation, measured live the same day:** `msedge` x29 = 3,125 MB
plus `msedgewebview2` x20 = 1,281 MB is **4.4 GB - more than `claude` x17 at 4,033 MB.** Closing idle
Edge windows buys back more than closing Claude sessions does.

Related: [[dont-skip-validation-for-ram-wait-instead]] ·
[[turbopack-500s-with-0xc0000142-when-commit-is-full]]

### Re-pinned 2026-08-26 afternoon - verified written, awaiting restart

The owner ran the elevated command. All three sources agree, so this is applied configuration and
not a silent no-op:

| Source | Value |
| --- | --- |
| `Win32_ComputerSystem.AutomaticManagedPagefile` | **False** |
| `Win32_PageFileSetting` | `C:\pagefile.sys`, InitialSize **32768**, MaximumSize **65536** |
| registry `PagingFiles` | `C:\pagefile.sys 32768 65536` |

**Check the registry value, not just the CIM object** - `?:\pagefile.sys` is the system-managed
marker and means the change did NOT take.

Expected after restart: **15.79 GB RAM + 32 GB = 47.79 GB minimum commit limit**, against 37.39 before.
Disk was checked first: `C:` had **83.4 GB free** with a 21.6 GB pagefile, so growing to the 32 GB
floor costs 10.4 GB and even the 64 GB ceiling leaves ~41 GB free. Every worktree was confirmed at
**0 uncommitted, 0 unpushed, 0 stashes** before the reboot was recommended - do that check first,
because a restart kills every live session.

### Confirmed live 2026-08-26 15:17 Cairo

Boot 15:14:49. Three minutes in, with the usual session load:

| | before reboot | after |
| --- | --- | --- |
| Commit limit | 37.39 GB | **47.79 GB** |
| Pagefile allocated | 22,109 MB | **32,768 MB** |
| Commit in use | 19.38 GB (52%) | 8.88 GB (**19%**) |

Prediction and measurement agreed exactly (15.79 GB RAM + 32 GB pagefile = 47.79). **This is now
the largest commit ceiling this machine has ever had** - 19.79 -> 31.79 -> 37.39 -> 47.79 across
the three attempts. Headroom is not immunity: the 85% warn threshold in
`~/.claude/scripts/ram-guard.ps1` is a percentage and re-scales itself, so it still fires at
~40.6 GB rather than at a stale absolute figure.

## The watchdog is the fix - ram-guard.ps1 was never going to catch this

**`~/.claude/scripts/ram-guard.ps1` polls every 30 MINUTES and, by its own explicit design,
NEVER kills anything.** The 2026-08-26 freeze went **22.22 GB -> 41.19 GB of commit in about
FORTY SECONDS** (one `node.exe`). No 30-minute reporter can see that, let alone stop it. Do not
"tune" ram-guard for freezes - it is a housekeeping/reporting tool and that is all it is.

**`NODE_OPTIONS=--max-old-space-size=8192` also does not work here.**
It caps the V8 JS heap only. ExcelJS workbook Buffers are OFF-heap, so the capped process still
reached 41 GB. Verified: a fresh node reports 8384 MB while the offender sat at 41 GB. Never treat
it as protection against an off-heap leak. **It is no longer set at any scope** — User, Machine and
process all read empty on 2026-09-21.

**The dev server is the opposite case (corrected 2026-09-21):** a cap in `NODE_OPTIONS` DOES bind it.
Without one, Next hands its `start-server.js` child HALF OF RAM (an 8,278 MB limit here) and restarts
it only past 80%; `scripts/dev-server.mjs` now sets 4,096 MB (a 4,288 MB limit) and bash-guard C7
refuses a raw `next dev`. Account: `docs/agents-worktree-and-machine-limits.md`, "The dev server's
heap cap".

**What actually works: `~/.claude/scripts/mem-watchdog.ps1`** (written 2026-08-26, PARSE OK).
Polls every 3s; kills any single non-protected process over **6 GB** commit, and above **88%**
global commit kills the single largest offender over 3 GB. Protects claude/powershell/dwm/system
and the attendance agent. Logs every kill with the full command line to
`~/.claude/scripts/mem-watchdog.log`.

**INSTALLED AND PROVEN 2026-08-26 16:38 Cairo.** Scheduled task
`PhoenixWorkforce Memory Watchdog`, `-AtLogOn`, state Running, `LastTaskResult` **267009**
(`SCHED_S_TASK_RUNNING`, which is correct for a task that never exits - not an error).

**The kill is demonstrated, not assumed.** A deliberate `Buffer.alloc` hog (OFF-heap, the exact
ExcelJS failure mode) was killed at **6.27 GB**, before reaching its own 8 GB self-cap:
`KILL pid=11900 name=node commit=6.27GB reason=over-per-process-ceiling / killed OK`.
That is the proof `--max-old-space-size` could never give.

**An agent cannot install it** - the Claude Code auto-mode classifier blocks `Start-Process` of a
detached hidden process, `Register-ScheduledTask`, AND writing any file that would register one.
The owner ran it by hand; elevation was NOT required. Note PowerShell has no `&` background
operator - a bash-style `... &` is a ParserError, use `Start-Process`.

**A single-instance guard was added** after two instances ran briefly and double-logged one kill
(two `total kills this run: 1` lines for ONE dead process, and the second kill's
`Get-CommandLineFor` returned `(command line unavailable)` because the process was already dying).
Same double-launch shape as [[attendance-agent-crashes-at-logon-but-loses-no-attendance]].

**Beware a false positive when checking whether it runs.** Filtering `Win32_Process` for a
CommandLine containing `mem-watchdog.ps1` matches the AGENT'S OWN PowerShell call, because the
path is inside the command being run. It reported "already running" twice against processes that
were the query itself. Filter on `'*-File*mem-watchdog.ps1*'` AND confirm the log file exists -
no log file means it has never run, whatever the process list says.

## The trigger on 2026-08-26 was the UNCOMMITTED portal test, run against BROKEN source

`tests/office-column-is-cns-only.test.ts` is registered in `run-tests.ts` (line 1426) and its
committed sections pass in CI: PR #2412's `validate` job went green in **4m09s on a 7 GB GitHub
runner**. So the suite is NOT inherently a memory hog and the office/xlsx builders are not at
fault - `writeOfficeSheet` and `writeMatrixSheet` were both read line by line and neither has an
unbounded loop; `tests/alias-loader.mjs` does no directory walking either.

What was running locally was **section 5, `runPortalWorkbookTests`, still uncommitted**, driven by
a 3-line scratch runner `tests/_tmp-run-office.mjs`, **against a source tree deliberately broken**
for break-verification (the `lineHasOfficeChannel(rebuiltMatrix.line)` gate at
`monthly-closing-export.ts:3536` removed).

### SOLVED 2026-08-26 16:51 - the DELIBERATE BREAK is what eats the memory

Reproduced under the armed watchdog, both directions, same machine, minutes apart:

| gate at `monthly-closing-export.ts:3536` | outcome |
| --- | --- |
| **removed** (break-verification) | **killed at 6.23 GB**, no result, would have kept climbing |
| **intact** | `RESULT: PASS`, exit 0, seconds, trivial memory |

So the runaway is **not** ExcelJS, not the office writers, not the alias loader, and not the test.
**Calling `buildPortalClosingWorkbook` for a non-CNS line with an Office layer attached is a
pathological path** - which is exactly the state the gate exists to prevent. The portal builder
rebuilds its matrix from `details.rows` (empty in the test) while the Office grid still carries
products, and the two disagree.

**Consequence for break-verification: this test cannot be broken-and-run locally.** With the gate
removed it does not fail an assertion, it exhausts memory - which is how it froze the laptop twice.
It is not vacuous: sections 1-4 pass with the gate removed, so section 5 is demonstrably the part
that reacts. But confirm it the safe way - run it with the gate INTACT and require `RESULT: PASS`,
and never remove that gate on a machine without the watchdog running.

**This is also a real product finding, not just a test artifact.** A gate whose removal OOMs the
process is load-bearing far beyond cosmetics. If the Office layer ever reaches a non-CNS portal
export through some other path, that export does not render wrong - it dies.

**This is the second time this exact shape has frozen the box**: a session removes a guard to prove
a new test fires, runs it locally through a scratch `.mjs`, and dies with the machine. The repo
rule already covers it - AGENTS.md section 7, *"CI is the gate. Do not run a local full
validation."* Break-verification is legitimate, but run it with the watchdog armed, or push the
branch and read the PR's `validate` job.

Related: [[a-red-main-ships-and-looks-fine-build-ignores-type-errors]]

### The watchdog DIES on a console close, and re-registering the task needs ELEVATION

At 17:2x on 2026-08-26 the watchdog was found **dead**: task state `Ready` (not `Running`), no
process, `LastTaskResult` **3221225786 = `0xC000013A` = `STATUS_CONTROL_C_EXIT`** - killed by a
Ctrl+C or a console close, not by a crash. **Nothing revived it**, because the task as registered
carries no `-RestartCount`.

**Adding `-RestartCount` needs an elevated shell.** `Register-ScheduledTask ... -Force` over an
EXISTING task returns **`0x80070005 Access is denied`** from a normal shell, even though the
FIRST registration of that same task succeeded unelevated. Creating is allowed; overwriting is not.

**`Start-ScheduledTask` still works unelevated** - that is how it was brought back (pid 20340,
17:40:03) without fixing the task definition. So a dead watchdog is always one unelevated
`Start-ScheduledTask -TaskName 'PhoenixWorkforce Memory Watchdog'` away from running again.

**Non-elevated substitute, installed 2026-08-26:** `~/.claude/scripts/ram-guard.ps1` now checks
every 30 minutes whether the watchdog is alive and `Start-Process`es it if not, logging
`memory watchdog: was DEAD - restarted it`. That caps unprotected time at 30 minutes without
needing elevation. It only ever STARTS a process - ram-guard still never kills anything.
To get the real 5-minute heartbeat, re-register the task from an **elevated** PowerShell with
`-RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)` plus a repeating `-Once` trigger.

**Checking whether it is alive: match on `-File`, exclude `$PID`, and require the LOG.** A
`CommandLine -like '*mem-watchdog.ps1*'` filter matches the QUERY ITSELF - it falsely reported
"already running" twice against the very command asking the question.

## 2026-08-26 (evening) - the limit is `RAM + ALLOCATED pagefile`, so it FLOATS. 47.79 is a FLOOR.

Everything above quotes the commit limit as a NUMBER. It is not one, and this file already held the
proof without naming it: the 43.16 GB reading earlier on this page was "system-managed, 28,023 MB
allocated", and 15.79 + 27.37 = 43.16. Same arithmetic every time.

**The rule:** `commit limit = physical RAM + the pagefile as CURRENTLY ALLOCATED on disk` - the
allocated size, never the configured maximum. Verified live 2026-08-26 ~22:25 Cairo:

| Reading | Value |
| --- | --- |
| RAM | 15.79 GB |
| `Win32_PageFileSetting` | Initial **32768** MB / Max **65536** MB |
| `Win32_PageFileUsage.AllocatedBaseSize` | **32768 MB** (peak usage only 1064 MB since the 21:35 boot) |
| `Win32_OperatingSystem.TotalVirtualMemorySize` | **47.79 GB** |
| limit minus RAM | **32.00 GB** - exactly the allocated pagefile |

Because the pin is a RANGE, Windows grows that file under pressure and the limit rises with it:
**47.79 GB at rest, up to ~79.79 GB fully grown, with nothing having been changed.**

**This retires the "~37.4 means it was reset again" heuristic in ONE DIRECTION ONLY.** A reading
BELOW 47.79 GB still means the setting was reset - Windows never shrinks below `InitialSize` while
the pin holds. A reading ABOVE it is ordinary growth and means nothing is wrong. Read
`AllocatedBaseSize` to tell the two apart; it is the only field that answers the question.

**This is what the unexplained 53.83 GB was.** The ExcelJS probe entry records commit going
22 -> 41 GB in 40 seconds and reaching "99.7% of 53.83 GB even WITH the fix". There was no third
reset: 53.83 - 15.79 = 38.04 GB, a pagefile Windows had grown from 32768 MB to ~38,950 MB during
that very spike. The `MEMORY.md` index line and `AGENTS.md` both carried that number with no
explanation, which made it read as evidence the pin had failed.

**And the sharp end: growth did NOT save the machine.** The limit had already floated up by ~6 GB
and the probe still reached 99.7%. Pagefile growth LAGS the allocation, so a fast spike wins the
race no matter how much room the range nominally allows. **Never budget headroom against the range
maximum - budget against what you just read, and treat a RISING limit as the machine already being
in trouble, not as spare capacity.**

Corrected in `AGENTS.md` §2.1 and §5 by #2428 (squash `06d46220`, merged 22:29 Cairo 2026-08-26),
which until then said flatly "the limit is now 47.79 GB".

## 2026-09-11 - memory starvation now leaves BLUESCREENS WITH DUMPS, and commit reads GREEN

"A freeze leaves no dump" is true of a COMMIT hang only. Four minidumps exist
(`C:\Windows\Minidump`, admin-only to read - the codes come from System 1001 and the WER
Application 1001 `P1..P5`, which need no elevation). Every one is the graphics/driver stack:

| Dump | Crash (Cairo) | Code | What preceded it |
| --- | --- | --- | --- |
| `082626-16156-01` | 08-26 ~15:38 | `0x10E` VIDEO_MEMORY_MANAGEMENT_INTERNAL (`17`, `0xC0000001`) | `dwm.exe` `0xc00001ad` at 15:33:25 and 15:34:18 - COMMIT exhaustion |
| `090426-16937-01` | 09-04 ~10:30 | `0x9F` P1=3 (a driver held a power IRP too long) | 8h of NVIDIA TDRs (142 x `nvlddmkm` 14, payload `CMDre ... ff1fe141`); no memory log survives for that date |
| `091126-19468-01` | 09-11 ~22:30 | `0x9F` P1=3 | watchdog: RAM available 168-921 MB from 22:15-22:22, `claude` x40, `node` x3-7, `msedge` x35; commit only ~33% |
| `091126-28640-01` | 09-11 ~22:50 | `0x116` VIDEO_TDR_FAILURE, P3 `0xC000009A` STATUS_INSUFFICIENT_RESOURCES; Windows names `nvlddmkm.sys` | rebooted 22:33 and everything reopened: RAM available **43 MB** at 22:37:57, `node` x3 7.7 GB; GPU timeout 0x141 at 22:47:45 |

**Commit was 26-28 of 79.79 GB (33-35%) through both 09-11 crashes** - the commit guard stayed
green while physical RAM hit bottom, exactly the two-ceilings trap in `AGENTS.md` §5. Three of the
three dumps with a surviving memory log sit minutes after a memory squeeze, so read a GPU-driver
bluescreen here as memory first, driver second. The drivers are still stale and make it worse:
NVIDIA `552.12` (2024-04-02, installed by the 08-26 reinstall) and Intel `27.20.100.9664` (2021) -
LibreOffice also died inside the Intel OpenCL driver (`igdrcl64.dll`) at 22:26:53, inside the squeeze.
**Reopening every session straight after a crash re-created the squeeze in 4 minutes** and caused
the second bluescreen. GPU itself read healthy after: 56 C, no thermal/power slowdown, zero WHEA
events. The two `0x9F` dumps do not name their driver without a debugger (`!analyze -v`, needs
elevation to read the file). Watchdog logs rotate fast (`mem-watchdog.log` began 09-09 22:49,
`ram-guard.log` 09-11 14:10), so the 09-04 and 09-09 nights cannot be checked against memory.

### 2026-09-11 23:28 - two fixes went live (owner: "fix now ... for permanent heavy work")

1. **`~/.claude/hooks/heavy-job-gate.mjs`** - user-level PreToolUse hook, matcher `Bash|PowerShell`, in
   `~/.claude/settings.json`. Refuses a command that STARTS a heavy node job (pnpm/npm dev, build, typecheck,
   test, ci, check:edit, lint; tsc; next dev/build; eslint; `tests/run-tests.ts`; `scripts/dev-server.mjs`)
   when available RAM is under **2,600 MB** OR another node.exe already holds **>= 1,200 MB** private. Judges
   each segment by how it STARTS, so a quoted command in git grep/rg/echo is not heavy. Fails open on any
   error. Cost ~70 ms per shell call (306 ms vs 233 ms bare node). `--selftest` 28/28; two deliberately broken
   copies went red. Probe `echo PHX_HEAVY_GATE_SELFTEST` is always refused. Log
   `~/.claude/scripts/heavy-job-gate.log`; off switch `PHX_HEAVY_GATE_OFF=1` in settings env. **Hooks load at
   SESSION START: it was not live in any session already open at 23:28** (this session's probe passed through).
   At real thresholds its first pipe test refused a second typecheck - two other sessions were running
   `tsc` at 4.2 + 2.7 GB with 613 MB available, tonight's shape again.
2. **`mem-watchdog.ps1` rule 7** - under **500 MB** available for 3 polls, kill the node.exe holding the most RAM
   (node only, one per 90 s cooldown, after rules 4/5 and never in a poll where they killed). Self-test 6/6,
   rule 5 regression 5/5, a sort-inverted copy failed its headline case, and an ARMED live pass killed only a
   marked dummy while three real node jobs survived. Restarted 23:28:37, pid 4076, START line carries
   `critRamMB=500`. Rollback copy: `mem-watchdog.ps1.bak-20260911-prerule7`.

**Left to the owner (system settings, not done):** graphics drivers through Dell Command | Update (NVIDIA
552.12 from 2024-04, Intel 27.20.100.9664 from 2021-06); Dell SupportAssist + TechHub agents measured at
~1.45 GB working set across 10 processes.

### 2026-09-12 - "not enough": the full heavy-work package (all live by 00:21 Cairo)

**Free RAM swings 379 -> 4,430 MB within minutes here, so one reading at admission time proves nothing.**
The first gate alone let a killed `tsc` straight back in: rule 7 killed pid 23868 (3,970 MB) at 00:04:59, the
gate saw 4,430 MB free at 00:05:06 and said ALLOW, and rule 7 killed the retry (pid 7980, 3,987 MB) at 00:06:34.
That retry loop is what the pieces below close.

1. **Admission rule, one module** `~/.claude/hooks/heavy-jobs-lib.mjs`, shared by the gate and the queue:
   (a) free RAM >= what THIS job needs - **5,000 MB** tsc / next build / `run typecheck|check:edit|build|ci`,
   **4,500 MB** dev server, **2,600 MB** anything else (`PHX_GATE_MIN_AVAIL_MB` forces one floor);
   (b) no other node.exe >= 1,200 MB private; (c) **90 s stagger** since the last admitted start;
   (d) **600 s pause after a watchdog MEMORY-PRESSURE kill** - read from the last 64 KB of `mem-watchdog.log`;
   hygiene kills (abandoned dev server) and `[LIVETEST]` lines do NOT count; fails open.
   Proof: `--selftest` 52 cases (31 classifier, 14 needMB, 7 kill-log), 0 failed; isolated pipe tests 6/0
   (recent real kill DENY with "until 00:26:53", LIVETEST-only / 15-min-old / hygiene kill ALLOW, typecheck
   at 4,305 MB DENY "needs at least 5,000 MB"). Rollback: `heavy-jobs-lib.mjs.bak-20260912-prekillcooldown`.
2. **`~/.claude/scripts/heavy-queue.mjs <cmd>`** - waits (max 20 min) until the same rule admits, then runs it.
   Exit **64** = no command, **75** = gave up waiting, otherwise the command's own exit code passes through
   (tested 3 -> 3). The gate's deny message names it.
3. **`memory-guard.mjs`** warns under 1,800 MB free.
4. **Watchdog rule 8** - two or more non-dev-server node jobs >= 1 GB while RAM is low: keep the OLDEST, kill
   the youngest, 120 s cooldown. **Rule 9** - every node.exe >= 1 GB gets BelowNormal CPU + LOW memory priority
   (non-destructive, healthy RAM too). Selftests rule8 6/0, rule7 6/0. **Live on dummies 00:21:02**: rule 8
   returned `killed`, older dummy alive, younger dead; rule 9 read back `BelowNormal` + memoryPriority `2`;
   0 dummies left. Watchdog restarted by the task at **00:17:26 (pid 23160)**, START line carries
   `batchMinGB=1 deprioMinGB=1 memPrioApi=True`; the 00:18:19 second launch exited on the mutex (1 instance).
   Rollbacks: `mem-watchdog.ps1.bak-20260911-prerule7`, `.bak-20260911-prerule8`.
5. **`~/.claude/scripts/phoenix-heavy-work-tuneup.ps1` - OWNER runs it elevated** (drivers via DCU, TdrDelay 8 /
   TdrDdiDelay 20, optional SupportAssist removal, memory compression; log `phoenix-heavy-work-tuneup.log`).
   Not run by any session - system settings.

**Hooks load at SESSION START** - only sessions opened after 23:42 Cairo 09-11 have the gate; older sessions
run heavy jobs unguarded until restarted (the watchdog still covers them). Typecheck belongs in CI anyway.
