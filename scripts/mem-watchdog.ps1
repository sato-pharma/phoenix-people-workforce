<#
Phoenix Workforce MEMORY WATCHDOG  -- the thing that actually prevents the freeze.
=================================================================================
WHY THIS EXISTS, AND WHY ram-guard.ps1 IS NOT ENOUGH:
  ram-guard.ps1 runs every 30 minutes and, by explicit design, NEVER kills anything.
  The 2026-08-26 freeze went 22.22 GB -> 41.19 GB of commit charge in about FORTY
  SECONDS (one node.exe running the office .xlsx tests). A 30-minute reporter cannot
  see that, let alone stop it. This script is the opposite: it polls every few seconds
  and it DOES kill, because by the time a human reads a warning the box is already wedged.

WHY --max-old-space-size DID NOT WORK:
  It caps the V8 JS heap only. ExcelJS builds real workbook Buffers, which live OFF-heap.
  The capped process still reached 41 GB. Only an external killer (or an OS job object)
  reaches that memory.

WHAT IT KILLS:
  A single process whose PRIVATE (commit) bytes exceed $KillGB, unless its name is on
  $Protected. Normal node.exe in this repo sits at 0.03-0.08 GB; a real next build peaks
  around 2-4 GB.

  RAISED 6.0 -> 8.0 GB, 2026-09-01, by the owner. The old ceiling was NOT above legitimate
  use: this repo's Next dev server routinely reaches 6.0-7.3 GB of commit while serving
  correctly, so the watchdog was reaping HEALTHY servers - 100 kill attempts since
  2026-08-26, 15 of them in one night, every restart re-driving physical RAM to ~94% and
  evicting the desktop to the pagefile. That sawtooth WAS the reported slowness.
  It is not a bundler trait: 7 of those kills came after the switch to webpack, at
  6.03-7.23 GB, indistinguishable from the 8 turbopack ones before it.
  8.0 still sits far below the ~47.8 GB commit limit and still catches the real runaway
  this watchdog exists for (a throwaway ExcelJS probe went 22 -> 41 GB in 40 seconds).

  ADDED 2026-09-09, rule 5: SEVERAL busy `next dev` servers at once, when physical RAM is
  already under the floor. Every rule above judges ONE process; nothing counted them, and
  concurrent servers - each legitimate, each under the 8 GB ceiling - are what hard-froze
  this box twice that day. It keeps the most recently active and reclaims the rest.

  ADDED 2026-09-11, rule 7: ANY node job - typecheck, test run, build, script - holding the most
  physical RAM, once available RAM has stayed under 500 MB for several polls. Rules 4 and 5 can
  only reach a Next dev server, and that night two bluescreens in 18 minutes came from node jobs
  neither recognised, with commit at a harmless 33-35%. See its config block above the mutex guard.

  ADDED 2026-09-11, rule 8: TWO OR MORE heavy node jobs that are not dev servers (typecheck, test
  run, build, script) over $BatchMinGB each, once available RAM has stayed under the floor for
  several polls. It keeps the OLDEST, which is closest to finishing, and reclaims the YOUNGEST, one
  per pass, then waits out a cooldown. At 23:24 that night two sessions ran tsc --noEmit together
  while available RAM sat at 543-613 MB. It runs after rules 4 and 5, before rule 7.

  ADDED 2026-09-11, rule 9: NON-DESTRUCTIVE, every poll, healthy RAM included. A node.exe over
  $DeprioMinGB is set once to BelowNormal CPU priority and LOW memory priority, so when RAM runs
  short Windows takes its pages before the desktop's and the graphics driver's. It never kills.

WHAT IT NEVER KILLS:
  claude / claude-code sessions (that is the owner's work), the attendance agent, and
  anything in $Protected (system, security, shell, dwm). It also refuses to kill PID<=4.

  A NEXT DEV SERVER, AS OF 2026-09-12, BY THE OWNER'S INSTRUCTION - "remove the watchdog kill for
  dev too". Every destructive rule now skips it: rule 1 (per-process ceiling), rule 2 (global
  commit), rule 3 (abandoned idle server), rule 4 (physical RAM), rule 5 (concurrent servers), rule
  6 (the kernel job cap - a dev server is no longer put INTO the job, so no allocation of its can
  fail) and rule 7 (critical RAM floor). Rule 8 already excluded dev servers. Rule 9 (deprioritize)
  was added to the exemption the same day, on the owner's second instruction - it never killed
  anything, but BelowNormal CPU and LOW memory priority are exactly what make a dev server feel
  slow, which is the complaint the whole exemption started from. It now also RESTORES a server it
  finds already demoted by an earlier instance. Rule 0 (the working-set trim) followed on the
  owner's third instruction the same day: it terminates nothing, but emptying an idle server's
  working set means its next request re-faults those pages off the disk, which is felt as a slow
  first hit after a pause - the same complaint by another route. A NEXT DEV SERVER WAS THEREFORE
  TOUCHED BY NOTHING IN THIS SCRIPT AT ALL - until 2026-09-21, when the owner re-armed rules 1 and 3
  for it (next paragraph but one). Everything else - sessions, browsers, typechecks, test runs - is
  trimmed exactly as before.

  THE TRADE, STATED PLAINLY SO NOBODY HAS TO REDISCOVER IT: rules 4, 5 and 7 exist because THIS
  SHAPE hard-froze this box twice on 2026-09-11, and one measured dev server held 10,221 MB of
  commit. Nothing above a dev server can reclaim it now. That is the owner's decision, not an
  oversight - do NOT re-arm any of it without him saying so. One switch reverses all of it:
  PHX_DEV_KILL_EXEMPT=0 in the environment, or $DevServerKillExempt below.

  TWO RULES RE-ARMED FOR A DEV SERVER, 2026-09-21, BY THE OWNER'S CHOICE - "Over 8 GB or unused 25
  min". Rule 1 stops a dev server at or over $KillGB of commit - a runaway, since a healthy one peaks
  at 6.0-7.3 GB (above) - and rule 3 stops one that has done no work for $NextIdleMinutes while
  holding $NextIdleMinGB or more - an abandoned one. Rules 0, 2, 4, 5, 6, 7 and 9 keep the 2026-09-12
  exemption, so a server in use and under $KillGB is still left alone however low RAM runs. WHY: from
  06:40 Cairo that morning a preview tab stuck in a redirect loop (/employee-portals/expenses <->
  /employee-portals/expense-dashboard) drove one server to 9.9 GB of commit and 5.7 GB resident for
  over an hour, available RAM sat between 500 and 1,800 MB, and nothing on the machine was allowed to
  stop it. Stopping the start-server.js child is enough: `next dev` exits whenever its child exits
  with anything but Next's own restart code (next/dist/cli/next-dev.js, child.on('exit')), and
  scripts/dev-server.mjs exits with it - nothing respawns. Both verdicts come from ONE pure function,
  Get-DevServerVerdict, which PHX_DEV_EXEMPT_SELFTEST asserts. PHX_DEV_RUNAWAY_STOP=0 puts rules 1
  and 3 back to the full 2026-09-12 exemption; PHX_DEV_KILL_EXEMPT=0 still re-arms every rule.

  RULE 15, ADDED 2026-10-29, BY THE OWNER'S CHOICE - "Add the guard (Recommended)": a dev server, and
  ONLY a dev server, under real memory pressure. Under the exemption nothing could stop one while it
  drove the box toward a freeze - that night a default `next dev` took available RAM down to 64 MB
  while the log could only say PRESSURE. Three steps, each one HELD, never decided on one sample:
    under $DevPressureWarnMB (1,200 MB) for $DevPressureWarnSec (15 s)    -> LOG only, once per 5 min;
    under $DevPressureStopMB (500 MB) AND over $DevPressurePagesPerSec (1,000) page reads/s, both held
      for $DevPressureStopSec (30 s) - the machine is paging itself into a freeze -> STOP the dev server;
    under $DevPressureFloorMB (300 MB) for $DevPressureFloorSec (15 s)    -> STOP it regardless.
  It stops the LARGEST dev server process (the start-server.js child - `next dev` and
  scripts/dev-server.mjs exit with it), one per window, then every clock starts again. It never stops
  Claude, a browser or any other app, and it changes no other threshold in this file. Its verdict is
  Get-DevServerVerdict 'pressure', asserted by PHX_DEV_EXEMPT_SELFTEST. PHX_DEV_PRESSURE_STOP=0 disarms
  the stop and keeps the log line; the pre-rule-15 file is mem-watchdog.ps1.bak-20261029-pre-devpressure.

HOW TO PROVE IT WORKS WITHOUT WEDGING THE MACHINE:
  PHX_MULTI_NEXT_SELFTEST=1  asserts rule 5's decision offline and exits (5 cases).
  PHX_MULTI_NEXT_LIVETEST=1  runs rule 5 against the real process table, FORCED to dry run.
  PHX_CRIT_SELFTEST=1        asserts rule 7's victim choice offline and exits (6 cases).
  PHX_CRIT_LIVETEST=1        runs rule 7 once on the real process table; dry run unless
                             PHX_CRIT_LIVETEST_KILL_LIKE limits it to a matching command line.
  PHX_BATCH_SELFTEST=1       asserts rule 8's victim choice offline and exits (6 cases).
  PHX_BATCH_LIVETEST=1       runs rule 8 once on the real process table; dry run unless
                             PHX_BATCH_LIVETEST_KILL_LIKE limits it to a matching command line
                             (PHX_BATCH_MIN_GB lowers the size bar so dummy processes count).
  PHX_DEPRIO_LIVETEST=1      applies rule 9 ONLY to processes matching PHX_DEPRIO_LIVETEST_LIKE
                             and prints the priorities read back (PHX_DEPRIO_MIN_GB for dummies).

LOG: C:\Users\satoh\.claude\scripts\mem-watchdog.log
#>

$ErrorActionPreference = 'Continue'

$KillGB          = 8.0     # per-process commit ceiling (6.0 -> 8.0 on 2026-09-01, see header)
$GlobalWarnPct   = 92      # commit-charge % at which we kill the single largest offender
$GlobalKillGB    = 7.5     # ...but only if that offender is at least this big
$PollSeconds     = 3

# RULE 2 RAISED 2026-09-03, by the owner: 88% -> 92%, and 3.0 -> 7.5 GB.
#
# This is the SAME correction the header records for $KillGB on 2026-09-01, applied to the rule
# that was left behind. That day the per-process ceiling went 6.0 -> 8.0 because it was reaping
# HEALTHY dev servers; rule 2 kept a 3.0 GB trigger, so it went on doing exactly that, just via a
# different code path. A Next dev compile in this repo crosses 3 GB before it serves a single
# page, and the header's own measurement is that the server legitimately reaches 6.0-7.3 GB.
#
# Measured 2026-09-03, four kills in six minutes, every one a dev server that had just answered
# a 307 and started compiling:
#       14:55:35  pid=14376  commit=3.64GB   reason=global-commit-94.1pct
#       14:57:10  pid=37244  commit=3.23GB   reason=global-commit-93.5pct
#       14:58:10  pid=29364  commit=3.28GB   reason=global-commit-92.8pct
#       15:00:37  pid=4268   commit=3.33GB   reason=global-commit-92.3pct
#
# THE REASON THE OLD SETTING COULD NOT WORK, which is what makes this safe rather than merely
# permissive: the pressure it fires on is NOT coming from the process it kills. The box sat at
# 85-94% because 42 claude.exe sessions held 13.4 GB, and $Protected means this script will never
# touch those - correctly, they are the owner's work. So the dev server was the only thing it
# could ever reach, and killing it did not relieve the pressure: the surrounding log is
# "PRESSURE ... no eligible target >= 3GB (nothing killed)" over and over, before and after each
# kill. It was paying the full cost of the reap-and-restart sawtooth the header blames for the
# slowness, and buying nothing.
#
# 7.5 sits above every legitimate reading in the header's range and below $KillGB, so a true
# runaway is still caught - by rule 1 at 8.0, which is what actually catches it (the ExcelJS
# probe went 22 -> 41 GB in 40 seconds and would cross 8.0 in about a second). Rule 3 (idle dev
# servers) and the physical-RAM floor below are UNTOUCHED, and they are the two that catch the
# real waste: a wedged server holding memory while answering nothing.
#
# THE RISK, stated plainly because it is real: at the moment of the last kill physical RAM was
# down to 522 MB free. Rule 2 firing later means less margin before the 2026-08-26 freeze mode.
# If the box starts wedging again, put this back to 88 / 3.0 first - the pre-change file is
# mem-watchdog.ps1.bak-20260903-preraise - and close sessions rather than lowering $KillGB.

# ---- PHYSICAL RAM PRESSURE (added 2026-09-01) -------------------------------------
# THE BLIND SPOT THIS CLOSES: every threshold above watches COMMIT charge, and the header
# of ram-guard.ps1 goes further - it calls free RAM "cache-inflated, NOT the ceiling" and
# ignores it on purpose. That was correct when the enemy was a FREEZE. It is exactly wrong
# now, and the 2026-09-01 night proves it: at 01:09 commit sat at 28.15/47.79 GB = 59%,
# nowhere near $GlobalWarnPct, while physical RAM was at 0.87 GB free of 15.79 GB = 94.5%.
# Nothing fired. Windows dealt with it the only way it can - by evicting working sets to the
# pagefile - and dwm.exe (the compositor that paints every window) ended up 4% resident,
# 0.07 GB in RAM out of 1.73 GB. Hard faults ran at 3,551/sec. CPU never passed 9%.
# That is what "the whole machine is slow" was, and no commit-based rule can ever see it:
# raising the pagefile to 32-64 GB cured the freeze precisely BY allowing the box to commit
# 3x its physical RAM, which guarantees paging instead. Freeze traded for permanent crawl.
$LowRamMB           = 1800   # available physical MB below which we are paging, not caching
$LowRamConsecutive  = 3      # polls in a row (3 x 3s ~ 9s) - ignores allocation spikes
$LowRamKillGB       = 1.0    # smallest dev server worth reclaiming under that pressure

# ---- ABANDONED DEV SERVERS (added 2026-09-01) -------------------------------------
# On 2026-09-01 three wedged `next dev` servers held 12 GB between them while answering no
# HTTP request at all, and two more held 10.5 GB. Size alone never caught them: each sat
# UNDER the 6 GB per-process ceiling. Idleness catches them, and a dev server is the one
# heavy process on this box that is free to kill - it holds no unsaved state and any session
# that still wants it just restarts it.
$NextIdleMinutes    = 25     # no measurable CPU for this long = nobody is using it
$NextIdleCpuSeconds = 1.0    # CPU-seconds across the whole window that still counts as work
$NextIdleMinGB      = 0.75   # do not bother reaping a server that costs nothing
$NextScanEverySec   = 60     # command-line scans are the expensive part - do them rarely

# ---- rule 5: CONCURRENT dev servers, all of them BUSY (added 2026-09-09) -----------
# THE HOLE THIS CLOSES is the one that hard-froze this box TWICE on 2026-09-09, at 17:34 and
# 20:36 Cairo. Neither left a minidump; both left a GPU watchdog dump instead
# (WATCHDOG-20260909-1734.dmp / -2038.dmp, video timeout 0x117 and 0x141), which is what
# starving the compositor looks like from the kernel's side - NOT a driver fault, and the
# nvlddmkm errors beside them are the symptom, not the cause.
#
# From this log, the hour before the second freeze: available physical RAM oscillated between
# 10 MB and 1.5 GB against the 1800 MB floor, 173 PRESSURE lines across the day, and node held
# 5.1-8.6 GB across FOUR TO SEVEN processes the whole time. The last line written before the
# screen locked was 20:35:54, 164 MB available.
#
# Rules 3 and 4 could not act, and said so on every one of those lines: "no idle dev server".
# THEY WERE ALL BUSY. Several `next dev` servers, each legitimately compiling, each under the
# 8 GB per-process ceiling, together larger than this 16 GB box. Every rule above keys on ONE
# process being wrong; nothing looked at the COUNT - so the shape that actually kills this
# machine was the one shape nothing watched.
#
# AGENTS.md 5 already states the rule this enforces: "One dev server at a time, ever." It was
# behavioural, and behaviour is what fails at 4am after a compaction. Under RAM pressure and
# only there, this makes it mechanical.
#
# WHY KILLING A *BUSY* SERVER IS SAFE HERE, given the header spends twenty lines on the
# 2026-09-03 sawtooth caused by reaping healthy ones: that sawtooth killed the ONLY server, so
# it relieved nothing and the session restarted it within seconds. This fires only when there
# is MORE THAN ONE and the box is already under the floor, it KEEPS the most recently active
# one, and it then leaves the survivor alone for a full cooldown. A dev server is still the one
# heavy process here that holds no unsaved state.
$MultiNextCooldownSec = 900   # after a pass, leave the survivor alone for 15 min. Restarting a
                              # dev server costs a compile, and reap-and-restart IS the 2026-09-03
                              # mistake. Kill once, then wait long enough to see if it helped.
$MultiNextMinGB       = 1.0   # below this a match is the cheap `next dev` PARENT, not a server
# Overridable for the same reason as PHX_TRIM_WARN_MB above - so the rule can be exercised
# without wedging the machine on purpose. PHX_MULTI_NEXT_SELFTEST asserts the decision itself
# and exits; see the block below the functions.
if ($env:PHX_MULTI_NEXT_COOLDOWN_SEC) { try { $MultiNextCooldownSec = [int]$env:PHX_MULTI_NEXT_COOLDOWN_SEC } catch {} }
if ($env:PHX_MULTI_NEXT_MIN_GB)       { try { $MultiNextMinGB = [double]$env:PHX_MULTI_NEXT_MIN_GB } catch {} }
# DRY RUN. The selection is asserted offline by PHX_MULTI_NEXT_SELFTEST, but that proves the
# DECISION, not the DISCOVERY - and discovery is where this rule can plausibly be wrong, because
# Get-NextDevServers matches the parent AND the child and only the size filter separates them.
# This mode runs the whole rule against the real process table and logs what it WOULD reclaim,
# terminating nothing. It is what makes "how many servers does it think are running" answerable
# on a healthy box, instead of only during the emergency the rule exists for.
$MultiNextDryRun = $false
if ($env:PHX_MULTI_NEXT_DRYRUN) { $MultiNextDryRun = $true }

# ---- rule 6: the OS-ENFORCED CEILING (added 2026-09-09) ---------------------------
# EVERY rule above this line polls, and polling is the wrong tool for a fast climb. This script's
# own header says so: the 2026-08-26 runaway went 22.22 GB -> 41.19 GB of commit in about FORTY
# SECONDS, and at a 3-second poll the machine spends that whole time over the line. The header
# also already names the fix - "Only an external killer (or an OS job object) reaches that
# memory" - and the job object was never built. This is it.
#
# A Windows job object enforces its limit inside the kernel's allocator. The offending
# VirtualAlloc simply FAILS, node throws or aborts, and there is no window at all in which the
# box is over budget. Two limits, catching different things:
#
#   PER-PROCESS - deterministic. The runaway is the process whose allocation fails, so the
#                 runaway is the one that dies. This is the 22 -> 41 GB catcher.
#   JOB TOTAL   - the SUM across every node.exe. This is what a per-process limit can never see,
#                 and it is exactly what froze the box on 2026-09-09: no single node process was
#                 over the line, four to seven of them TOGETHER were. The cost is that the
#                 allocation which fails belongs to whichever process asks next, not necessarily
#                 the guilty one, so this sits UNDER rule 5, which picks its victim deliberately.
#                 By the time this fires the alternative is a frozen desktop.
#
# THE NUMBERS ARE MEASURED, NOT GUESSED. On 2026-09-09, one `next dev --webpack` server serving
# ten admin routes from cold peaked at 10,221 MB of commit; with the two dev-only flags added to
# next.config.ts that day it peaked at 5,933 MB. 7.0 GB per process therefore sits above a
# healthy server and far below a runaway. 11.0 GB total is already past what this 16 GB box can
# hold once sessions and the browser are counted, so nothing legitimate should ever reach it.
#
# SHARED FATE, STATED PLAINLY: the job holds EVERY node.exe, not only dev servers, because a
# typecheck at 4 GB beside a server at 6 GB is the same 10 GB of pressure and a dev-server-only
# job cannot see it. So if the total is ever reached, another session's node script can be the
# one that fails. That is the trade, and it is the right way round on a machine that has hard
# frozen twice in one day.
#
# NO KILL_ON_JOB_CLOSE - see phx-job-cap.ps1. With that flag a watchdog restart would take every
# dev server with it. Proven by scripts/phx-job-cap.test.ps1, which carries a negative control:
# the same allocator reaches 1,600 MB outside the job and dies at 350 MB inside a 400 MB one.
$JobCapPerProcessGB = 7.0
$JobCapTotalGB      = 11.0
$JobCapEnabled      = $true
if ($env:PHX_JOBCAP_PER_PROCESS_GB) { try { $JobCapPerProcessGB = [double]$env:PHX_JOBCAP_PER_PROCESS_GB } catch {} }
if ($env:PHX_JOBCAP_TOTAL_GB)       { try { $JobCapTotalGB = [double]$env:PHX_JOBCAP_TOTAL_GB } catch {} }
if ($env:PHX_JOBCAP_OFF)            { $JobCapEnabled = $false }

# ---- rule 0: NON-DESTRUCTIVE RECLAIM (added 2026-09-08) ---------------------------
# THE HOLE THIS CLOSES, in this script's own words. From the log, 2026-09-08 01:19-01:22,
# over a hundred consecutive lines, bottoming at 356 MB available:
#
#   "PRESSURE physical RAM 356MB available (floor 1800)
#    - no IDLE dev server to reclaim; left everything running on purpose."
#
# Rule 4 was not misconfigured. It had NO MOVE TO MAKE. Every rule above can only KILL,
# and $Protected (correctly) puts the owner's 24 claude processes and 96 browser processes
# out of reach, which leaves exactly one eligible target class: an idle `next dev`. When
# there isn't one, the guard watches the box page itself into a crawl and does nothing.
# That is the whole of "RAM always throttled and full" - not a leak, a guard with one tool.
#
# EmptyWorkingSet is the second tool. It evicts a process's resident pages - clean pages to
# the standby list, dirty pages to the pagefile - WITHOUT terminating it. The process keeps
# every byte of its state and faults back only what it touches again. So the exact class
# that must never be KILLED is perfectly safe to TRIM.
#
# Measured on this box 2026-09-08 01:29, with all 24 sessions and 96 browser processes open:
#   80 idle processes trimmed, 7,470 MB of working set evicted,
#   available RAM 1,870 -> 3,042 MB, then 4,284 MB as compression caught up.
#   Nothing killed. Every session, tab and the dev server on 3000 still running.
#   Hard page reads fell to 10-77/sec (the 2026-09-01 crawl ran at 3,551/sec).
#
# It fires at a WARN floor ABOVE rule 4's kill floor, so the free move is always tried
# first and rule 4 becomes the fallback it was meant to be rather than the only rule.
#
# IDLE IS LOAD-BEARING, NOT A NICETY: trimming a process that is working makes it fault its
# pages straight back in, which is the "throttled" feeling itself. A process is trimmed only
# when it shows no measurable CPU across the whole scan interval, and the FOREGROUND window's
# process is exempt at any size. Remove either gate and this rule becomes a cause.
$TrimWarnMB         = 3600   # RAISED 2600 -> 3600, 2026-09-25, by the owner. The box spent the afternoon of
                             # 2026-09-25 hovering at 2.7-2.8 GB free - ABOVE the old 2600 trim floor and above the
                             # 1800 kill floor - so it sat untended in the dead band between the two rules and drifted
                             # into a crawl for hours with nothing reclaiming. 3600 makes rule 0's non-destructive trim
                             # engage before that drift instead of never. Safe because rule 0 kills nothing, spares the
                             # Claude sessions and dev server, and the $TrimMinYieldMB/$TrimBackoffSec backoff below stops
                             # any trim/fault-back sawtooth. Revert: put this back to 2600 (backup: .bak-20260925-pretrimraise).
# Overridable ONLY so the rule can be proved to fire. A guard that has never been observed
# doing its job is a guard nobody should trust: with healthy RAM this branch is unreachable,
# so without an override the only way to test it is to wedge the machine on purpose. Set
# PHX_TRIM_WARN_MB high (e.g. 99999) to force a pass, watch for the TRIM line, then unset it.
# It is NOT a tuning knob for normal running - the live default is the 2600 above.
if ($env:PHX_TRIM_WARN_MB) { try { $TrimWarnMB = [int]$env:PHX_TRIM_WARN_MB } catch {} }
$TrimEverySec       = 120    # do not thrash - evicted pages need time to prove they were not wanted
$TrimMinPrivateMB   = 50     # not worth a syscall below this
$TrimIdleCpuSec     = 0.05   # CPU-seconds across the scan interval that still counts as idle

# BACKOFF, and why it is not optional. Trimming has a real cost: evicted pages fault back in,
# and measured here that burst ran 2,978 hard reads/sec before draining to 8/sec over 30s. One
# burst is a fine trade for 2.2 GB. Repeating it forever is not - and it WOULD repeat, because
# after a full trim this box settles at ~2,480 MB available, which sits just UNDER $TrimWarnMB.
# Without a backoff rule 0 would re-fire every $TrimEverySec for the rest of the session: a
# trim/fault-back sawtooth around the trigger, which is the exact "throttled" symptom it exists
# to remove. Once a pass stops yielding, the idle pages are already gone; stop asking.
$TrimMinYieldMB     = 150    # a pass freeing less than this has run out of idle pages...
$TrimBackoffSec     = 600    # ...so stop re-scanning for 10 min. A real emergency overrides it.
# Overridable for the same reason as PHX_TRIM_WARN_MB above, and it matters more here: a bug in
# the backoff does not fail loudly, it silently stops rule 0 from ever running again - which is
# indistinguishable from the pre-2026-09-08 behaviour this whole rule was written to fix. Set
# PHX_TRIM_MIN_YIELD_MB very high to force the backoff branch and watch it engage AND expire.
if ($env:PHX_TRIM_MIN_YIELD_MB) { try { $TrimMinYieldMB = [int]$env:PHX_TRIM_MIN_YIELD_MB } catch {} }
if ($env:PHX_TRIM_BACKOFF_SEC)  { try { $TrimBackoffSec = [int]$env:PHX_TRIM_BACKOFF_SEC  } catch {} }

$LogPath         = 'C:\Users\satoh\.claude\scripts\mem-watchdog.log'
$MaxLogLines     = 800

# Never terminate these, at any size.
$Protected = @(
  'System','Idle','Registry','Memory Compression','csrss','wininit','winlogon','services',
  'lsass','smss','svchost','dwm','explorer','fontdrvhost','sihost','ctfmon','RuntimeBroker',
  'MsMpEng','SecurityHealthService','claude','Claude','Code','powershell','pwsh',
  # Added 2026-09-01 with the RAM-pressure rule below. A "kill the largest offender" rule that
  # can reach a browser or an editor is a rule that eventually eats the owner's open tabs or
  # unsaved buffers. Everything the new rule targets is explicitly a dev server instead.
  'chrome','msedge','firefox','brave','ChatGPT Classic','Notion','slack','Teams',
  'Phoenix.Attendance.Agent','WindowsTerminal','OpenConsole','conhost'
)

# ---- DEV SERVERS ARE EXEMPT FROM EVERY KILL (owner, 2026-09-12) --------------------
# $Protected is a never-kill list keyed on PROCESS NAME, which cannot express this: a dev server is
# node.exe, and so is every typecheck, test run and script the rules below must still be able to
# reach. So the exemption is keyed on the COMMAND LINE instead, through one predicate
# (Test-IsDevServerCmdLine) used by every rule, so they can never disagree about what a dev server
# is. It matches the same two patterns Get-NextDevServers has always used, which is deliberate:
# a server this script can FIND is a server it must not kill.
# Prove the predicate:  PHX_DEV_EXEMPT_SELFTEST=1   (table-driven, with negative controls, exits;
#                                                   since 2026-09-21 it also asserts the rule 1 / rule 3
#                                                   re-arm through Get-DevServerVerdict)
# Prove the discovery:  PHX_DEV_EXEMPT_LIVETEST=1   (every live node.exe, exempt or not, exits)
$DevServerKillExempt = $true
if ($env:PHX_DEV_KILL_EXEMPT -eq '0') { $DevServerKillExempt = $false }
# ---- ...EXCEPT A RUNAWAY AND AN ABANDONED ONE (owner, 2026-09-21) -------------------
# He chose "Over 8 GB or unused 25 min": rule 1 stops a dev server at or over $KillGB, rule 3 one that
# has done no work for $NextIdleMinutes. Every other rule keeps the exemption above. Both verdicts come
# from Get-DevServerVerdict, and the loop calls that same function, so PHX_DEV_EXEMPT_SELFTEST asserts
# the code that actually runs. PHX_DEV_RUNAWAY_STOP=0 disarms both and restores the 2026-09-12 skip.
$DevServerCeilingArmed = $true
$DevServerIdleArmed    = $true
if ($env:PHX_DEV_RUNAWAY_STOP -eq '0') { $DevServerCeilingArmed = $false; $DevServerIdleArmed = $false }
# ---- ...AND ONE THAT IS FREEZING THE MACHINE (owner, 2026-10-29) - rule 15 --------------------------
# He chose "Add the guard (Recommended)". Time is measured on the wall clock, not in polls: a poll under
# pressure takes longer than $PollSeconds, and counting polls would stretch every window exactly when it
# matters. See the header paragraph for the reasoning; the numbers live only here.
$DevPressureWarnMB      = 1200   # under this for $DevPressureWarnSec -> log only
$DevPressureWarnSec     = 15
$DevPressureWarnEverySec = 300   # the warn line at most once per 5 min, so it cannot evict KILL records
$DevPressureStopMB      = 500    # under this AND paging over $DevPressurePagesPerSec...
$DevPressurePagesPerSec = 1000   # ...page READS per second (Memory\Page Reads/sec)...
$DevPressureStopSec     = 30     # ...both held this long -> stop the dev server
$DevPressureFloorMB     = 300    # under this for $DevPressureFloorSec -> stop it regardless of paging
$DevPressureFloorSec    = 15
$DevPressureMinGB       = 0.5    # never "stop" the 0.07 GB `next dev` parent: it frees nothing
$DevServerPressureArmed = $true
if ($env:PHX_DEV_PRESSURE_STOP -eq '0') { $DevServerPressureArmed = $false }
$script:devExemptLogged = @{}   # rule+pid -> last log time, so a skip cannot flood a 3-second poll
$script:devExemptCache  = @{}   # pid -> is a dev server. Rules 6 and 9 each decide a pid ONCE and
                                # mark it done; rule 0 rebuilds its candidate list every pass, so it
                                # would pay a CIM query per node process forever without this. Pruned
                                # as pids die, in the same place rule 0 prunes its CPU samples.

function Get-CairoNow {
  try {
    $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById('Egypt Standard Time')
    return [System.TimeZoneInfo]::ConvertTimeFromUtc((Get-Date).ToUniversalTime(), $tz)
  } catch { return (Get-Date).ToUniversalTime().AddHours(2) }
}

function Write-Log {
  param([string]$Line)
  $stamped = "[{0:yyyy-MM-dd HH:mm:ss} Cairo] {1}" -f (Get-CairoNow), $Line
  try { Add-Content -Path $LogPath -Value $stamped -Encoding utf8 } catch {}
}

function Trim-Log {
  try {
    if (Test-Path $LogPath) {
      $lines = Get-Content $LogPath
      if ($lines.Count -gt $MaxLogLines) {
        $lines | Select-Object -Last $MaxLogLines | Set-Content $LogPath -Encoding utf8
      }
    }
  } catch {}
}

function Get-CommandLineFor {
  param([int]$ProcId)
  try {
    $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction Stop).CommandLine
    if ($c) { return $c.Substring(0, [Math]::Min(300, $c.Length)) }
  } catch {}
  return '(command line unavailable)'
}

function Get-FullCommandLineFor {
  # Get-CommandLineFor TRUNCATES to 300 characters for logging. The exemption must never be decided on
  # a truncated string: a long node path plus flags can push the start-server.js marker past 300, and
  # that failure would read a dev server as NOT a dev server - i.e. kill it. Full text here.
  param([int]$ProcId)
  try { return [string](Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction Stop).CommandLine } catch {}
  return ''
}

function Test-IsDevServerCmdLine {
  # PURE. The one definition of "this is a Next dev server", asserted by PHX_DEV_EXEMPT_SELFTEST.
  param([string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  # THREE patterns, not the two Get-NextDevServers uses. That function is DISCOVERY - it finds servers
  # to act on - and it is right to stay narrow. This is a NEVER-KILL test, where the cost of a miss is
  # the thing the owner asked to prevent, so it also covers this repo's own wrapper
  # (scripts/dev-server.mjs, which pnpm run dev launches and which carries neither Next marker).
  return ($CommandLine -like '*next*dist*server*' -or
          $CommandLine -like '*next*dev*' -or
          $CommandLine -like '*scripts?dev-server.mjs*')
}

function Test-DevServerExempt {
  # The gate every destructive rule calls. Pass -CommandLine when the caller already holds the FULL
  # text, to save a CIM query; never pass a truncated one.
  param([int]$ProcId, [string]$CommandLine)
  if (-not $DevServerKillExempt) { return $false }
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { $CommandLine = Get-FullCommandLineFor -ProcId $ProcId }
  return (Test-IsDevServerCmdLine -CommandLine $CommandLine)
}

function Test-DevServerExemptCached {
  # Same answer as Test-DevServerExempt, one CIM query per pid per lifetime. For callers that
  # re-evaluate the same process on every pass - rule 0 is the only one.
  param([int]$ProcId)
  if (-not $DevServerKillExempt) { return $false }
  if ($script:devExemptCache.ContainsKey($ProcId)) { return $script:devExemptCache[$ProcId] }
  $v = [bool](Test-DevServerExempt -ProcId $ProcId)
  $script:devExemptCache[$ProcId] = $v
  return $v
}

function Get-DevServerVerdict {
  # PURE. The whole of the 2026-09-21 re-arm in one place; returns 'stop' or 'spare', terminates nothing.
  #   ceiling (rule 1): stop at or over $KillGB of commit - only a runaway gets there.
  #   idle    (rule 3): stop after $NextIdleMinutes with no work, while holding $NextIdleMinGB or more.
  # Any other rule answers 'spare': rules 0, 2, 4, 5, 6, 7 and 9 keep the 2026-09-12 exemption and do
  # not call this. The armed flags default to the live config; the self-test passes them explicitly.
  #   pressure (rule 15, 2026-10-29): 'stop' once the thrash clock reaches $DevPressureStopSec or the
  #            floor clock $DevPressureFloorSec; 'warn' (log only) once the warn clock reaches
  #            $DevPressureWarnSec, or when the stop is disarmed. The clocks come from
  #            Update-DevPressureClocks; this function only reads them.
  param([string]$Rule, [double]$GB, [double]$IdleMin = 0,
        [bool]$CeilingArmed = $DevServerCeilingArmed, [bool]$IdleArmed = $DevServerIdleArmed,
        [double]$WarnSec = 0, [double]$ThrashSec = 0, [double]$FloorSec = 0,
        [bool]$PressureArmed = $DevServerPressureArmed)
  if ($Rule -eq 'ceiling') {
    if ($CeilingArmed -and $GB -ge $KillGB) { return 'stop' }
  } elseif ($Rule -eq 'idle') {
    if ($IdleArmed -and $IdleMin -ge $NextIdleMinutes -and $GB -ge $NextIdleMinGB) { return 'stop' }
  } elseif ($Rule -eq 'pressure') {
    if ($PressureArmed -and ($ThrashSec -ge $DevPressureStopSec -or $FloorSec -ge $DevPressureFloorSec)) { return 'stop' }
    if ($WarnSec -ge $DevPressureWarnSec) { return 'warn' }
  }
  return 'spare'
}

function Get-DevPressurePageRate {
  # PURE. Page reads per second between two raw samples of Win32_PerfRawData_PerfOS_Memory
  # (.Reads = PageReadsPersec, a running count; .Time = Timestamp_PerfTime; .Freq = Frequency_PerfTime).
  # Anything it cannot measure - a first sample, a clock that did not move, a 32-bit counter that
  # wrapped - reads as 0, i.e. CALM: bad data must never be what stops a dev server. The 300 MB floor
  # needs no rate at all, so it still backstops a machine whose counter is unreadable.
  param($Prev, $Cur)
  if ($null -eq $Prev -or $null -eq $Cur -or $Cur.Freq -le 0) { return 0 }
  $dt = ($Cur.Time - $Prev.Time) / $Cur.Freq
  if ($dt -le 0) { return 0 }
  $dn = $Cur.Reads - $Prev.Reads
  if ($dn -lt 0) { return 0 }
  return $dn / $dt
}

function Update-DevPressureClocks {
  # PURE apart from the hashtable it is handed. Moves rule 15's three clocks one poll forward and returns
  # how long each condition has held, in seconds. A clock starts at the first sample that meets its
  # condition and is cleared by the first that does not - one calm sample restarts the whole window.
  param([hashtable]$State, [int]$AvailMB, [double]$PageReads, [datetime]$Now)
  $State.WarnSince   = if ($AvailMB -lt $DevPressureWarnMB) { if ($State.WarnSince) { $State.WarnSince } else { $Now } } else { $null }
  $State.ThrashSince = if ($AvailMB -lt $DevPressureStopMB -and $PageReads -gt $DevPressurePagesPerSec) { if ($State.ThrashSince) { $State.ThrashSince } else { $Now } } else { $null }
  $State.FloorSince  = if ($AvailMB -lt $DevPressureFloorMB) { if ($State.FloorSince) { $State.FloorSince } else { $Now } } else { $null }
  return @{
    WarnSec   = $(if ($State.WarnSince)   { ($Now - $State.WarnSince).TotalSeconds }   else { 0 })
    ThrashSec = $(if ($State.ThrashSince) { ($Now - $State.ThrashSince).TotalSeconds } else { 0 })
    FloorSec  = $(if ($State.FloorSince)  { ($Now - $State.FloorSince).TotalSeconds }  else { 0 })
  }
}

function Select-DevPressureVictim {
  # PURE. The ONE dev server process rule 15 stops: the largest at or over $DevPressureMinGB, or $null.
  # Input: objects carrying .Id and .GB, built only from Get-NextDevServers - so nothing that is not a
  # dev server can ever be offered to it.
  param([object[]]$Servers)
  $big = @($Servers | Where-Object { $_ -and $_.GB -ge $DevPressureMinGB } | Sort-Object GB -Descending)
  if ($big.Count) { return $big[0] }
  return $null
}

function Get-ExemptDevServerPids {
  # The set of live node.exe pids rule 0 must leave resident, as a hashtable for O(1) lookup inside
  # its filter. Also PRUNES the memo: without that, a machine running for days leaks one entry per
  # node process ever seen, and pid reuse would let a NEW process inherit a dead one's verdict -
  # the same bookkeeping bug rule 6's assigned-set comments call out.
  $live = @{}
  $out = @{}
  foreach ($np in (Get-Process -Name node -ErrorAction SilentlyContinue)) {
    $live[$np.Id] = $true
    if (Test-DevServerExemptCached -ProcId $np.Id) { $out[$np.Id] = $true }
  }
  foreach ($k in @($script:devExemptCache.Keys)) { if (-not $live.ContainsKey($k)) { $script:devExemptCache.Remove($k) } }
  return $out
}

function Write-DevExemptSkip {
  # THROTTLED. Rules 1, 2 and 7 re-evaluate on the 3-second poll, so an un-throttled skip line would
  # fill $MaxLogLines in minutes and evict the KILL records the log exists for - the same eviction the
  # PRESSURE rate limit was added to fix. Once per rule per pid per 10 minutes.
  param([int]$ProcId, [string]$Rule)
  $key = "$Rule/$ProcId"
  $last = $script:devExemptLogged[$key]
  if ($null -ne $last -and ((Get-Date) - $last).TotalSeconds -lt 600) { return }
  $script:devExemptLogged[$key] = Get-Date
  # "would have killed it" was WRONG for two of the seven callers and the log said so out loud:
  # rules 0 and 9 never terminate anything, so that wording invited a future session to believe the
  # trim kills. The line is rule-neutral now and each caller names what it would have done.
  Write-Log ("SPARED pid={0} name=node  {1} left it alone - a dev server is EXEMPT (owner 2026-09-12; PHX_DEV_KILL_EXEMPT=0 restores)" -f $ProcId, $Rule)
}

function Get-NextDevServers {
  # Identify a Next dev server by the module path Next itself launches. Matching the CHILD is
  # what matters: `next dev --webpack` (the parent) is cheap, while the start-server.js child it
  # spawns is the one holding the gigabytes - and that child's command line carries no "dev"
  # flag at all, which is why a naive match on "dev" finds nothing. Measured 2026-09-01:
  #   pid 23220  4.47 GB  ...next\dist\server\lib\start-server.js     <- the real cost
  #   pid 10348  0.07 GB  next dev --webpack --port 3100              <- the parent
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and ($_.CommandLine -like '*next*dist*server*' -or $_.CommandLine -like '*next*dev*') })
  } catch { return @() }
}

# ---- rule 5 machinery: concurrent dev servers (added 2026-09-09) ---------------
function Select-DevServerVictims {
  # PURE selection. Takes plain objects, touches no process, terminates nothing. It is split
  # out from the rule precisely SO THAT IT CAN BE ASSERTED - see the PHX_MULTI_NEXT_SELFTEST
  # block below. Proving this decision by forcing the live box under the RAM floor is not an
  # acceptable way to find out whether it is right, and a guard whose decision has never been
  # observed is a guard nobody should trust.
  #
  # Input : objects carrying .Id, .GB, .LastActive
  # Output: hashtable @{ Keep = <one object or $null>; Victims = @(objects, worst-kept last) }
  param([object[]]$Servers)
  $list = @($Servers | Where-Object { $_ })
  if ($list.Count -le 1) {
    $only = $null
    if ($list.Count -eq 1) { $only = $list[0] }
    return @{ Keep = $only; Victims = @() }
  }
  # The most recently ACTIVE survives: that is the server whoever is at the keyboard is using,
  # and the ones a previous session walked away from are what this rule is for. TIE-BREAK on
  # size ASCENDING - two servers first seen in the same scan carry the same LastActive, and
  # keeping the smaller of them frees more. Without a second key the order would be whatever
  # the process enumeration happened to return, which is not a decision anyone can test.
  $ordered = @($list | Sort-Object @{ Expression = { $_.LastActive }; Descending = $true },
                                   @{ Expression = { $_.GB }; Descending = $false })
  return @{ Keep = $ordered[0]; Victims = @($ordered | Select-Object -Skip 1) }
}

function Invoke-ConcurrentDevServerReclaim {
  # Rule 5. Returns $true if it killed something, $false if it left the box alone.
  #
  # Called ONLY from rule 4's "nothing to do" branch, so everything below is already true when
  # it runs: physical RAM is under $LowRamMB, rule 0 has trimmed every idle page it safely can,
  # and no dev server is quiet enough for rules 3 or 4 to reclaim. This is the last move before
  # the log line that was all this script could manage on 2026-09-09.
  param([int]$AvailMB)

  # OWNER EXEMPTION 2026-09-12: this rule can ONLY ever kill dev servers, so it now has no move at all.
  # Left in place rather than deleted so PHX_DEV_KILL_EXEMPT=0 restores it whole, with its selftest.
  if ($DevServerKillExempt) { Write-DevExemptSkip -ProcId 0 -Rule 'rule 5 (concurrent dev servers)'; return $false }

  if ($null -ne $script:lastMultiNextKill -and
      ((Get-Date) - $script:lastMultiNextKill).TotalSeconds -lt $MultiNextCooldownSec) { return $false }

  # SIZE IS WHAT COUNTS SERVERS, not the number of matches: Get-NextDevServers deliberately
  # matches BOTH the cheap `next dev --webpack` parent (~0.07 GB) and the start-server.js child
  # holding the gigabytes. Counting raw matches would read ONE server as two and reap a box that
  # is running exactly the one server it is supposed to.
  $servers = @()
  foreach ($ns in (Get-NextDevServers)) {
    $proc = Get-Process -Id $ns.ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.Id -le 4) { continue }                        # same floor every other rule keeps
    if ($Protected -contains $proc.ProcessName) { continue } # cannot happen for node.exe, kept so
                                                             # the never-kill list stays the ONE
                                                             # place that answers "is this safe"
    $gb = $proc.PM / 1GB
    if ($gb -lt $MultiNextMinGB) { continue }
    $entry = $nextSeen[$ns.ProcessId]
    $lastActive = if ($entry) { $entry.LastActive } else { Get-Date }
    $servers += [pscustomobject]@{ Id = $proc.Id; GB = $gb; LastActive = $lastActive; Proc = $proc }
  }
  if ($servers.Count -le 1) { return $false }

  $pick = Select-DevServerVictims -Servers $servers
  if (-not $pick.Victims.Count) { return $false }

  Write-Log ("MULTI {0} dev servers alive and BUSY at {1}MB available (floor {2}) - AGENTS.md 5 allows one. Keeping the most recently active: pid={3} {4:N2}GB. Reclaiming {5}." -f $servers.Count, $AvailMB, $LowRamMB, $pick.Keep.Id, $pick.Keep.GB, $pick.Victims.Count)

  if ($MultiNextDryRun) {
    foreach ($v in $pick.Victims) {
      Write-Log ("DRYRUN would kill pid={0} name=node commit={1:N2}GB (concurrent dev server) - nothing was terminated" -f $v.Id, $v.GB)
    }
    return $false   # no kill, so no cooldown either - a dry run must leave no state behind
  }

  $acted = $false
  foreach ($v in $pick.Victims) {
    $quietMin = ((Get-Date) - $v.LastActive).TotalMinutes
    Write-Log ("KILL  pid={0} name=node commit={1:N2}GB  reason=concurrent-dev-server-{2}-alive-quiet-{3:N0}min" -f $v.Id, $v.GB, $servers.Count, $quietMin)
    Write-Log ("      cmd: {0}" -f (Get-CommandLineFor -ProcId $v.Id))
    try {
      Stop-Process -Id $v.Id -Force -ErrorAction Stop
      $script:killCount++
      $acted = $true
      Write-Log ("      killed OK (concurrent dev server; total kills this run: {0})" -f $script:killCount)
    } catch {
      Write-Log ("      KILL FAILED: {0}" -f $_.Exception.Message)
    }
    if ($nextSeen) { $nextSeen.Remove($v.Id) }
  }
  # The cooldown starts only if something actually died. A pass where every Stop-Process failed
  # must be free to try again rather than silently standing down for 15 minutes.
  if ($acted) { $script:lastMultiNextKill = Get-Date }
  return $acted
}

# ---- rule 0 machinery: non-destructive working-set trim (added 2026-09-08) ---
$phxWsSig = @'
using System;
using System.Runtime.InteropServices;
public static class PhxWs {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool K32EmptyWorkingSet(IntPtr hProcess);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
$script:TrimAvailable = $true
try { if (-not ('PhxWs' -as [type])) { Add-Type -TypeDefinition $phxWsSig -ErrorAction Stop } }
catch { $script:TrimAvailable = $false }

# NEVER TRIM. Distinct from $Protected, which is a never-KILL list: the two lists differ on
# purpose. Browsers and claude sessions are never killed but ARE trimmed - that is the whole
# point of rule 0. What lands here is the narrow set where trimming is itself harmful:
#   - kernel pseudo-processes, which cannot be opened at all;
#   - dwm, the compositor that paints every window - visible stutter to reclaim ~107 MB;
#   - MsMpEng (Defender), which re-faults immediately and aggressively;
#   - Memory Compression, which IS the cache we are evicting into. Trimming it is circular.
# A dev server is NOT on this list and must not be added to it: $NeverTrim is keyed on process NAME,
# and the name is node.exe - which is also every typecheck, test run and script that rule 0 should
# still trim. It is excluded by COMMAND LINE instead, in the candidate filter below (owner 2026-09-12).
$NeverTrim = @(
  'System','Idle','Registry','Memory Compression','Secure System','csrss','wininit',
  'winlogon','services','lsass','smss','svchost','dwm','fontdrvhost','MsMpEng',
  'SecurityHealthService','LsaIso','WUDFHost'
)

function Get-AvailableMB {
  try { return [int](Get-CimInstance Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop).AvailableMBytes } catch {}
  try { return [int]((Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).FreePhysicalMemory / 1KB) } catch {}
  return 99999   # fail SAFE: unknown headroom must never look like pressure
}

function Invoke-WorkingSetTrim {
  # Returns @(freedMB, processCount). Terminates nothing, ever, under any condition.
  # $trimCpu is a hashtable in the caller's scope; mutating it here is by reference.
  # -ListOnly returns the candidate processes and trims nothing (rule 10's live test uses it).
  param([switch]$ListOnly)
  if (-not $script:TrimAvailable) { return @(0.0, 0) }
  $fgPid = 0
  try { [void][PhxWs]::GetWindowThreadProcessId([PhxWs]::GetForegroundWindow(), [ref]$fgPid) } catch {}
  # OWNER EXEMPTION 2026-09-12. Resolved BEFORE the filter, never inside it: a Where-Object block
  # that called the logger would have to be sure the logger emits nothing to the pipeline, and one
  # stray object there silently turns the filter's boolean into a truthy value - i.e. it would trim
  # EVERYTHING. Built as a set up front, the filter stays a pure test.
  $devSkip = Get-ExemptDevServerPids
  foreach ($k in $devSkip.Keys) { Write-DevExemptSkip -ProcId $k -Rule 'rule 0 (working-set trim)' }
  # CLAUDE FIRST (owner, 2026-09-12 23:40). Claude's processes are NOT trimmed any more - see rule 10.
  # A session waiting on the model burns ~no local CPU, so the idle gate below read every waiting
  # session as idle and evicted it every 2 minutes; the reply then faulted it back from disk, which is
  # the "Claude is slow" feeling itself. The yield was noise: 23:29:56 "freed 511MB working set;
  # available 1910MB -> 1923MB". The ONE exception is the crash floor ($CritRamMB): below it a
  # fault-back burst is cheaper than the no-dump bluescreen, so Claude is trimmed like anything else.
  $claudeSkip = @{}
  if ($ClaudeFirstEnabled -and (Get-AvailableMB) -ge $CritRamMB) { $claudeSkip = Get-ClaudeFamilyCached }
  $script:trimClaudeSpared = $claudeSkip.Count
  $cands = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Id -gt 4 -and $_.Id -ne $PID -and $_.Id -ne $fgPid -and
    ($NeverTrim -notcontains $_.ProcessName) -and
    (-not $devSkip.ContainsKey($_.Id)) -and
    (-not $claudeSkip.ContainsKey($_.Id)) -and
    (($_.PrivateMemorySize64 / 1MB) -ge $TrimMinPrivateMB)
  })
  if ($ListOnly) { return ,$cands }
  if (-not $cands.Count) { return @(0.0, 0) }

  # SEED INLINE when we hold no CPU history for these processes. The idle gate needs a PREVIOUS
  # sample, so without this the first pass can judge nobody and trims NOTHING - pushing the first
  # real reclaim out to 2 x $TrimEverySec, four minutes into exactly the emergency this rule
  # exists for. Measured 2026-09-08: a forced pass logged no TRIM line for this reason. One 1.5s
  # sample buys a usable idle signal immediately; every later pass reuses the free
  # across-the-interval comparison and never pays it again.
  $known = 0
  foreach ($p in $cands) { if ($trimCpu.ContainsKey($p.Id)) { $known++ } }
  if ($known -lt [int]($cands.Count / 2)) {
    foreach ($p in $cands) { try { $trimCpu[$p.Id] = $p.CPU } catch {} }
    Start-Sleep -Milliseconds 1500
  }

  $freed = 0.0
  $n = 0
  foreach ($p in $cands) {
    try { $p.Refresh() } catch { continue }
    if ($p.HasExited) { continue }

    # idle gate - compares CPU against the previous sample (the scan interval, or the 1.5s
    # seed above on a cold first pass)
    $prev = $trimCpu[$p.Id]
    $cpuNow = $null
    try { $cpuNow = $p.CPU } catch { continue }
    $trimCpu[$p.Id] = $cpuNow
    if ($null -eq $prev) { continue }                      # first sighting - judge it next pass
    if (($cpuNow - $prev) -gt $TrimIdleCpuSec) { continue } # busy - leave it resident

    $before = $p.WorkingSet64 / 1MB
    if ($before -lt 1) { continue }
    try {
      if ([PhxWs]::K32EmptyWorkingSet($p.Handle)) {
        $p.Refresh()
        $d = $before - ($p.WorkingSet64 / 1MB)
        if ($d -gt 0) { $freed += $d; $n++ }
      }
    } catch {}   # process exited, or we may not open it - both are fine to skip
  }

  # RELEASE THE HANDLES THIS PASS OPENED. $p.Handle pins a real OS process handle inside each
  # .NET Process object, and without an explicit Dispose they are freed only whenever the GC
  # gets round to finalizing them. In a loop meant to run for DAYS that makes the guard slowly
  # become the memory problem it exists to catch - and that is not hypothetical: measured
  # 2026-09-08, this build reached 188 MB and 555 handles in 24 MINUTES, against the previous
  # build's 87 MB after SEVEN HOURS. The collect is affordable because it runs once per trim
  # pass ($TrimEverySec), never on the 3s poll.
  foreach ($p in $cands) { try { $p.Dispose() } catch {} }
  [System.GC]::Collect()
  return @($freed, $n)
}

# ---- rule 5 self-test (added 2026-09-09) ------------------------------------
# Runs the REAL selection function against table-driven cases, prints PASS/FAIL, and exits.
# It runs BEFORE the mutex guard on purpose, so it never disturbs the live instance, and it
# touches no process, writes nothing to the log and can kill nothing by construction.
#
#   $env:PHX_MULTI_NEXT_SELFTEST=1; powershell -File mem-watchdog.ps1; $env:PHX_MULTI_NEXT_SELFTEST=$null
#
# Exit code is 1 if any case fails, so it is usable from a checker. To confirm the assertions
# themselves fire, invert the Descending flag on LastActive in Select-DevServerVictims IN A COPY
# and re-run: cases 3, 4 and 5 must go FAIL. A green run of a test that cannot go red proves
# nothing, which is the trap AGENTS.md 2.1 records under "prove RED before quoting a green".
if ($env:PHX_MULTI_NEXT_SELFTEST) {
  $t0 = Get-Date
  function New-TestServer { param($id, $gb, $minsAgo) [pscustomobject]@{ Id = $id; GB = $gb; LastActive = $t0.AddMinutes(-$minsAgo) } }
  $cases = @(
    @{ Name = 'no server at all         '; In = @();                                                                                        Keep = $null; Victims = @() }
    @{ Name = 'one server is never reaped'; In = @((New-TestServer 11 7.0 30));                                                              Keep = 11;    Victims = @() }
    @{ Name = 'two: newest survives      '; In = @((New-TestServer 11 6.0 5), (New-TestServer 22 6.0 1));                                    Keep = 22;    Victims = @(11) }
    @{ Name = 'three: both older go      '; In = @((New-TestServer 11 6.0 9), (New-TestServer 22 6.0 1), (New-TestServer 33 6.0 4));         Keep = 22;    Victims = @(33, 11) }
    @{ Name = 'tie on time: smaller stays'; In = @((New-TestServer 11 6.0 0), (New-TestServer 22 2.0 0));                                    Keep = 22;    Victims = @(11) }
  )
  $fails = 0
  foreach ($c in $cases) {
    $got = Select-DevServerVictims -Servers $c.In
    $gotKeep = if ($got.Keep) { $got.Keep.Id } else { $null }
    $gotVics = @($got.Victims | ForEach-Object { $_.Id })
    $ok = ($gotKeep -eq $c.Keep) -and ((($gotVics) -join ',') -eq (($c.Victims) -join ','))
    if (-not $ok) { $fails++ }
    Write-Output ("SELFTEST rule5 {0} : {1}  keep expected={2} got={3} | victims expected=[{4}] got=[{5}]" -f `
      $c.Name, $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.Keep, $gotKeep, (($c.Victims) -join ','), (($gotVics) -join ','))
  }
  Write-Output ("SELFTEST rule5 {0} cases, {1} failed" -f $cases.Count, $fails)
  exit $(if ($fails) { 1 } else { 0 })
}

# ---- rule 5 live discovery check (added 2026-09-09) -------------------------
# One pass of the WHOLE rule against the real process table, FORCED into dry run, then exit.
# Answers "what does this rule currently see on this box" without waiting for the box to be
# in trouble. It cannot terminate anything: dry run is set here, not read from the environment,
# so forgetting the env var cannot arm it. Pair it with PHX_MULTI_NEXT_MIN_GB to make cheap
# stand-in processes count as servers.
#
#   $env:PHX_MULTI_NEXT_LIVETEST=1; powershell -File mem-watchdog.ps1; $env:PHX_MULTI_NEXT_LIVETEST=$null
if ($env:PHX_MULTI_NEXT_LIVETEST) {
  $MultiNextDryRun = $true
  $nextSeen = @{}                       # no CPU history offline: every server reads as just-seen
  $script:lastMultiNextKill = $null
  $script:killCount = 0
  $avail = Get-AvailableMB
  Write-Output ("LIVETEST rule5  available={0}MB  minGB={1}  dryRun=TRUE" -f $avail, $MultiNextMinGB)
  foreach ($ns in (Get-NextDevServers)) {
    $p = Get-Process -Id $ns.ProcessId -ErrorAction SilentlyContinue
    if ($p) { Write-Output ("  match pid={0} commit={1:N2}GB counted={2}" -f $p.Id, ($p.PM/1GB), (($p.PM/1GB) -ge $MultiNextMinGB)) }
  }
  $r = Invoke-ConcurrentDevServerReclaim -AvailMB $avail
  Write-Output ("LIVETEST rule5 returned {0} (must be False in dry run); see the log for MULTI/DRYRUN lines" -f $r)
  exit 0
}

# ---- rule 7: CRITICAL physical-RAM floor, ANY heavy node job (added 2026-09-11) --------------
# THE HOLE THIS CLOSES: rules 4 and 5 can only ever reach a NEXT DEV SERVER. On 2026-09-11 this box
# bluescreened twice in 18 minutes, and both times the memory sat in node jobs neither rule
# recognises. From this log and the event log, Cairo time:
#
#   22:19:50  available 168 MB; 22:21:04 "PRESSURE ... Top holders: node x3 5169MB, msedge x36 2928MB, claude x39 2876MB"
#   ~22:30    BUGCHECK 0x9F DRIVER_POWER_STATE_FAILURE                      (minidump 091126-19468-01)
#   22:37:13  available 206 MB, "node x3 7725MB, claude x23 3655MB"; 22:37:57 available 43 MB
#   22:47:45  GPU engine timeout, LiveKernelEvent 0x141
#   ~22:50    BUGCHECK 0x116 VIDEO_TDR_FAILURE, nvlddmkm.sys, STATUS_INSUFFICIENT_RESOURCES (091126-28640-01)
#
# Commit sat at 33-35% throughout, so rules 1, 2 and 6 were nowhere near firing, and every PRESSURE
# line ended at "no idle dev server". Starved of physical RAM the graphics driver cannot page its own
# allocations back in, times out, and takes the whole machine with it - unsaved Excel, every session.
# Below THIS floor a node job of any kind (typecheck, test run, build, script) is the cheaper loss.
#
# THE LAST MOVE, NOT THE FIRST: the floor sits far under rule 4's 1800 MB, so rules 0, 4 and 5 always
# act first and this fires only when RAM keeps falling anyway, for several polls in a row. It takes
# ONE process per pass - the node.exe holding the most physical RAM, because RAM is what is missing -
# then waits out a cooldown so the freed pages can land before it judges again. node.exe only:
# sessions, browsers, editors and everything on $Protected stay out of reach, exactly as before.
#
# THE COST, stated plainly: the 09-11 daytime log also dipped to 187-400 MB and the box survived, so
# this can reclaim a job during a dip that would have passed. That costs one re-run; a bluescreen
# costs everything that was open. If it proves too eager, raise $CritRamConsecutive before lowering
# $CritRamMB - both bluescreens were preceded by MINUTES under the floor.
#
# The old companion, a heavy-job gate that refused to START a heavy node job while RAM was short, was
# REMOVED 2026-09-17 (owner instruction) - nothing prevents a heavy job now; this is the only backstop.
#
# PROVE IT: PHX_CRIT_SELFTEST=1 asserts the victim choice offline (6 cases) and exits.
#           PHX_CRIT_LIVETEST=1 runs one pass on the real process table - DRY RUN, unless
#           PHX_CRIT_LIVETEST_KILL_LIKE names a command-line pattern, and then it can only ever kill a
#           process whose command line matches it (how the kill path is proven on a dummy node).
$CritRamMB          = 500    # available physical MB
$CritRamConsecutive = 3      # polls in a row (3 x 3s ~ 9s, longer under pressure) - a spike is not an emergency
$CritKillMinGB      = 1.0    # private bytes; below this a node.exe is a hook or an MCP server, not a job
$CritCooldownSec    = 90     # after a kill, let Windows hand the memory back before judging again
$critLowStreak      = 0
$lastCritLog        = (Get-Date).AddMinutes(-5)
$script:lastCritKill = $null

function Get-TopHolderSummary {
  param([object[]]$Procs)
  try {
    return (($Procs | Where-Object { $_.Id -gt 4 } | Group-Object ProcessName |
      ForEach-Object { [pscustomobject]@{ N = $_.Name; C = $_.Count; MB = [math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1MB) } } |
      Sort-Object MB -Descending | Select-Object -First 3 |
      ForEach-Object { "{0} x{1} {2}MB" -f $_.N, $_.C, $_.MB }) -join ', ')
  } catch { return 'unavailable' }
}

function Select-CriticalVictim {
  # PURE selection for rule 7, split out so PHX_CRIT_SELFTEST can assert it. Terminates nothing.
  # Input : objects carrying .Name .Id .WSMB (working set, MB) .PMGB (private bytes, GB)
  # Output: the one object to reclaim, or $null
  param([object[]]$Candidates, [double]$MinGB)
  $eligible = @($Candidates | Where-Object { $_ -and $_.Name -eq 'node' -and $_.Id -gt 4 -and $_.PMGB -ge $MinGB })
  if (-not $eligible.Count) { return $null }
  # Most RAM held first - RAM is what the box is out of. Tie-break on commit, so the order is a
  # decision rather than whatever the process enumeration happened to return.
  return ($eligible | Sort-Object @{ Expression = { $_.WSMB }; Descending = $true },
                                  @{ Expression = { $_.PMGB }; Descending = $true } | Select-Object -First 1)
}

function Invoke-CriticalRamReclaim {
  # Rule 7. Returns 'killed', 'cooldown', 'none', 'dryrun' or 'failed'.
  param([int]$AvailMB, [object[]]$Procs, [string]$OnlyCmdLike = '', [switch]$DryRun)
  if ($null -ne $script:lastCritKill -and
      ((Get-Date) - $script:lastCritKill).TotalSeconds -lt $CritCooldownSec) { return 'cooldown' }
  $cands = @()
  foreach ($p in $Procs) {
    if ($p.ProcessName -ne 'node') { continue }
    if ($Protected -contains $p.ProcessName) { continue }   # cannot happen for node; keeps ONE never-kill list
    try { $cands += [pscustomobject]@{ Name = $p.ProcessName; Id = $p.Id; WSMB = [math]::Round($p.WorkingSet64 / 1MB); PMGB = ($p.PM / 1GB) } } catch {}
  }
  if ($OnlyCmdLike) { $cands = @($cands | Where-Object { (Get-CommandLineFor -ProcId $_.Id) -like $OnlyCmdLike }) }
  # OWNER EXEMPTION 2026-09-12. NOT applied when $OnlyCmdLike is set: that is the operator's own live
  # test naming one command line, and it must stay able to reach whatever it names. A real pass never
  # sets $OnlyCmdLike, so the exemption always holds where it matters.
  if ($DevServerKillExempt -and -not $OnlyCmdLike) {
    $kept = @()
    foreach ($c in $cands) {
      if (Test-DevServerExempt -ProcId $c.Id) { Write-DevExemptSkip -ProcId $c.Id -Rule 'rule 7 (critical RAM)'; continue }
      $kept += $c
    }
    $cands = $kept
  }
  $v = Select-CriticalVictim -Candidates $cands -MinGB $CritKillMinGB
  if (-not $v) { return 'none' }
  $tag = ''
  if ($OnlyCmdLike -or $DryRun) { $tag = ' [LIVETEST]' }
  Write-Log ("CRITICAL{0} physical RAM {1}MB available (floor {2}) for {3} polls - the zone both 2026-09-11 bluescreens came from. Reclaiming the node job holding the most RAM." -f $tag, $AvailMB, $CritRamMB, $CritRamConsecutive)
  if ($DryRun) {
    Write-Log ("DRYRUN would kill pid={0} name=node ram={1}MB commit={2:N2}GB (rule 7) - nothing was terminated" -f $v.Id, $v.WSMB, $v.PMGB)
    return 'dryrun'
  }
  Write-Log ("KILL  pid={0} name=node ram={1}MB commit={2:N2}GB  reason=critical-RAM-{3}MB-available{4}" -f $v.Id, $v.WSMB, $v.PMGB, $AvailMB, $tag)
  Write-Log ("      cmd: {0}" -f (Get-CommandLineFor -ProcId $v.Id))
  try {
    Stop-Process -Id $v.Id -Force -ErrorAction Stop
    $script:killCount++
    $script:lastCritKill = Get-Date
    Write-Log ("      killed OK (critical RAM floor; total kills this run: {0})" -f $script:killCount)
    return 'killed'
  } catch {
    Write-Log ("      KILL FAILED: {0}" -f $_.Exception.Message)
    return 'failed'
  }
}

# ---- rule 7 self-test (added 2026-09-11) --------------------------------------
# Runs the REAL selection function against table-driven cases, prints PASS/FAIL, exits. Before the
# mutex guard like rule 5's, so it never disturbs the live instance and can kill nothing.
#   $env:PHX_CRIT_SELFTEST=1; powershell -File mem-watchdog.ps1; $env:PHX_CRIT_SELFTEST=$null
if ($env:PHX_CRIT_SELFTEST) {
  function New-CritProc { param($name, $id, $wsMB, $pmGB) [pscustomobject]@{ Name = $name; Id = $id; WSMB = $wsMB; PMGB = $pmGB } }
  $critCases = @(
    @{ Name = 'nothing running            '; In = @();                                                                                                            Expect = $null }
    @{ Name = 'small node = hook, not job '; In = @((New-CritProc 'node' 11 300 0.2));                                                                           Expect = $null }
    @{ Name = 'most RAM held goes first   '; In = @((New-CritProc 'node' 11 1500 5.0), (New-CritProc 'node' 22 3000 4.0));                                       Expect = 22 }
    @{ Name = 'never a browser or session '; In = @((New-CritProc 'msedge' 11 4000 3.0), (New-CritProc 'claude' 22 3500 3.0), (New-CritProc 'node' 33 1200 1.5)); Expect = 33 }
    @{ Name = 'tie on RAM: bigger commit  '; In = @((New-CritProc 'node' 11 2000 2.0), (New-CritProc 'node' 22 2000 3.0));                                       Expect = 22 }
    @{ Name = 'pid 4 and below, never     '; In = @((New-CritProc 'node' 4 5000 6.0));                                                                           Expect = $null }
  )
  $critFails = 0
  foreach ($c in $critCases) {
    $got = Select-CriticalVictim -Candidates $c.In -MinGB 1.0
    $gotId = $null
    if ($got) { $gotId = $got.Id }
    $ok = ($gotId -eq $c.Expect)
    if (-not $ok) { $critFails++ }
    Write-Output ("SELFTEST rule7 {0} : {1}  expected={2} got={3}" -f $c.Name, $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.Expect, $gotId)
  }
  Write-Output ("SELFTEST rule7 {0} cases, {1} failed" -f $critCases.Count, $critFails)
  exit $(if ($critFails) { 1 } else { 0 })
}

# ---- rule 7 live check (added 2026-09-11) --------------------------------------
# One pass of Invoke-CriticalRamReclaim on the real process table, then exit. DRY RUN unless
# PHX_CRIT_LIVETEST_KILL_LIKE is set - and then only a process whose command line matches it can die.
#   $env:PHX_CRIT_LIVETEST=1; powershell -File mem-watchdog.ps1; $env:PHX_CRIT_LIVETEST=$null
if ($env:PHX_CRIT_LIVETEST) {
  $script:lastCritKill = $null
  $script:killCount = 0
  if ($env:PHX_CRIT_MIN_GB) { try { $CritKillMinGB = [double]$env:PHX_CRIT_MIN_GB } catch {} }
  $like = [string]$env:PHX_CRIT_LIVETEST_KILL_LIKE
  $availNow = Get-AvailableMB
  $procsNow = @(Get-Process -ErrorAction SilentlyContinue)
  Write-Output ("LIVETEST rule7  available={0}MB  minGB={1}  killOnlyLike=[{2}]" -f $availNow, $CritKillMinGB, $like)
  foreach ($np in ($procsNow | Where-Object { $_.ProcessName -eq 'node' })) {
    Write-Output ("  node pid={0} ram={1}MB commit={2:N2}GB counted={3}" -f $np.Id, [math]::Round($np.WorkingSet64 / 1MB), ($np.PM / 1GB), (($np.PM / 1GB) -ge $CritKillMinGB))
  }
  $r = 'none'
  if ($like) { $r = Invoke-CriticalRamReclaim -AvailMB $availNow -Procs $procsNow -OnlyCmdLike $like }
  else { $r = Invoke-CriticalRamReclaim -AvailMB $availNow -Procs $procsNow -DryRun }
  Write-Output ("LIVETEST rule7 returned '{0}'" -f $r)
  exit 0
}

# ---- rule 8: CONCURRENT heavy batch jobs under the floor (added 2026-09-11) --------------------
# Rule 5 for everything that is not a Next dev server. At 23:24-23:28 on 2026-09-11 - under an hour
# after the second bluescreen - two sessions were running `tsc --noEmit` at the same time, 4.2 GB and
# 2.7 GB of commit, while available RAM fell to 543-613 MB: the shape that had just crashed the machine
# twice. Both sessions were opened before the heavy-job gate existed, so nothing refused them. The
# watchdog has to be able to see this on its own. AGENTS.md 5: "one typecheck/build at a time locally".
#
# Same trigger as rule 4 (under $LowRamMB for $LowRamConsecutive polls). With TWO OR MORE node jobs over
# $BatchMinGB that are not dev servers, it keeps the OLDEST - it has done the most work and is closest
# to finishing - and reclaims the YOUNGEST, ONE per pass, then waits out a cooldown. Rule 5 keeps the
# most recently ACTIVE dev server instead, because somebody is looking at that one; nobody is looking
# at a typecheck, it only has progress to lose.
#
# PROVE IT: PHX_BATCH_SELFTEST=1 asserts the choice offline (6 cases). PHX_BATCH_LIVETEST=1 runs one pass
#           on the real process table - dry run, unless PHX_BATCH_LIVETEST_KILL_LIKE limits it to a
#           matching command line (PHX_BATCH_MIN_GB lowers the size bar so dummy processes count).
$BatchMinGB           = 1.0
$BatchCooldownSec     = 120
$batchLowStreak       = 0
$batchKillMark        = $null
$lastBatchScan        = (Get-Date).AddMinutes(-1)
$script:lastBatchKill = $null

function Get-HeavyBatchJobs {
  # node.exe over MinGB of private memory that is NOT a Next dev server (rule 5 owns those). One CIM
  # query, made only once rule 8's trigger already holds - never on the plain 3-second poll.
  param([double]$MinGB)
  $out = @()
  try {
    foreach ($w in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)) {
      $gb = ([double]$w.PrivatePageCount) / 1GB     # PrivatePageCount is BYTES despite its name
      if ($gb -lt $MinGB) { continue }
      $cl = [string]$w.CommandLine
      if ($cl -like '*next*dist*server*' -or $cl -like '*next*dev*') { continue }
      $out += [pscustomobject]@{ Id = [int]$w.ProcessId; GB = $gb; Started = $w.CreationDate; Cmd = $cl }
    }
  } catch {}
  return $out
}

function Select-BatchVictim {
  # PURE selection for rule 8, split out so PHX_BATCH_SELFTEST can assert it. Terminates nothing.
  # Input : objects carrying .Id .GB .Started
  # Output: @{ Keep = oldest; Victim = youngest } or $null when fewer than two jobs qualify
  param([object[]]$Jobs, [double]$MinGB)
  $list = @($Jobs | Where-Object { $_ -and $_.Id -gt 4 -and $_.GB -ge $MinGB })
  if ($list.Count -lt 2) { return $null }
  # Oldest first. TIE-BREAK on size ascending, so on an identical start time the LARGER job is the one
  # reclaimed - it frees more - and the order is a decision, not whatever the enumeration returned.
  $ordered = @($list | Sort-Object @{ Expression = { $_.Started }; Descending = $false },
                                   @{ Expression = { $_.GB }; Descending = $false })
  return @{ Keep = $ordered[0]; Victim = $ordered[$ordered.Count - 1] }
}

function Invoke-ConcurrentBatchReclaim {
  # Rule 8. Returns 'killed', 'cooldown', 'none', 'dryrun' or 'failed'.
  param([int]$AvailMB, [string]$OnlyCmdLike = '', [switch]$DryRun, [double]$MinGB = $BatchMinGB)
  if ($null -ne $script:lastBatchKill -and
      ((Get-Date) - $script:lastBatchKill).TotalSeconds -lt $BatchCooldownSec) { return 'cooldown' }
  $jobs = @(Get-HeavyBatchJobs -MinGB $MinGB)
  if ($OnlyCmdLike) { $jobs = @($jobs | Where-Object { $_.Cmd -like $OnlyCmdLike }) }
  $pick = Select-BatchVictim -Jobs $jobs -MinGB $MinGB
  if (-not $pick) { return 'none' }
  $tag = ''
  if ($OnlyCmdLike -or $DryRun) { $tag = ' [LIVETEST]' }
  $v = $pick.Victim
  Write-Log ("BATCH{0} {1} heavy node jobs running at once at {2}MB available (floor {3}) - AGENTS.md 5 allows one. Keeping the oldest: pid={4} {5:N2}GB started {6:HH:mm:ss}. Reclaiming the youngest." -f $tag, $jobs.Count, $AvailMB, $LowRamMB, $pick.Keep.Id, $pick.Keep.GB, $pick.Keep.Started)
  if ($DryRun) {
    Write-Log ("DRYRUN would kill pid={0} name=node commit={1:N2}GB started {2:HH:mm:ss} (rule 8) - nothing was terminated" -f $v.Id, $v.GB, $v.Started)
    return 'dryrun'
  }
  Write-Log ("KILL  pid={0} name=node commit={1:N2}GB started={2:HH:mm:ss}  reason=concurrent-batch-jobs-{3}-running{4}" -f $v.Id, $v.GB, $v.Started, $jobs.Count, $tag)
  Write-Log ("      cmd: {0}" -f $v.Cmd.Substring(0, [Math]::Min(300, $v.Cmd.Length)))
  try {
    Stop-Process -Id $v.Id -Force -ErrorAction Stop
    $script:killCount++
    $script:lastBatchKill = Get-Date
    Write-Log ("      killed OK (concurrent batch job; total kills this run: {0})" -f $script:killCount)
    return 'killed'
  } catch {
    Write-Log ("      KILL FAILED: {0}" -f $_.Exception.Message)
    return 'failed'
  }
}

# ---- rule 8 self-test (added 2026-09-11) --------------------------------------
#   $env:PHX_BATCH_SELFTEST=1; powershell -File mem-watchdog.ps1; $env:PHX_BATCH_SELFTEST=$null
if ($env:PHX_BATCH_SELFTEST) {
  $t0 = Get-Date
  function New-BatchJob { param($id, $gb, $minsAgo) [pscustomobject]@{ Id = $id; GB = $gb; Started = $t0.AddMinutes(-$minsAgo) } }
  $batchCases = @(
    @{ Name = 'no job at all              '; In = @();                                                                            Keep = $null; Victim = $null }
    @{ Name = 'one job is never reaped    '; In = @((New-BatchJob 11 4.0 5));                                                     Keep = $null; Victim = $null }
    @{ Name = 'two: oldest kept           '; In = @((New-BatchJob 11 4.2 10), (New-BatchJob 22 2.7 1));                           Keep = 11;    Victim = 22 }
    @{ Name = 'three: only youngest goes  '; In = @((New-BatchJob 11 2.0 9), (New-BatchJob 22 3.0 1), (New-BatchJob 33 4.0 4));   Keep = 11;    Victim = 22 }
    @{ Name = 'tie on start: larger goes  '; In = @((New-BatchJob 11 2.0 3), (New-BatchJob 22 3.0 3));                            Keep = 11;    Victim = 22 }
    @{ Name = 'small job does not count   '; In = @((New-BatchJob 11 4.0 10), (New-BatchJob 22 0.5 1));                           Keep = $null; Victim = $null }
  )
  $batchFails = 0
  foreach ($c in $batchCases) {
    $got = Select-BatchVictim -Jobs $c.In -MinGB 1.0
    $gotKeep = $null; $gotVictim = $null
    if ($got) { $gotKeep = $got.Keep.Id; $gotVictim = $got.Victim.Id }
    $ok = ($gotKeep -eq $c.Keep) -and ($gotVictim -eq $c.Victim)
    if (-not $ok) { $batchFails++ }
    Write-Output ("SELFTEST rule8 {0} : {1}  keep expected={2} got={3} | victim expected={4} got={5}" -f $c.Name, $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.Keep, $gotKeep, $c.Victim, $gotVictim)
  }
  Write-Output ("SELFTEST rule8 {0} cases, {1} failed" -f $batchCases.Count, $batchFails)
  exit $(if ($batchFails) { 1 } else { 0 })
}

# ---- rule 8 live check (added 2026-09-11) --------------------------------------
if ($env:PHX_BATCH_LIVETEST) {
  $script:lastBatchKill = $null
  $script:killCount = 0
  $min = $BatchMinGB
  if ($env:PHX_BATCH_MIN_GB) { try { $min = [double]$env:PHX_BATCH_MIN_GB } catch {} }
  $like = [string]$env:PHX_BATCH_LIVETEST_KILL_LIKE
  $availNow = Get-AvailableMB
  Write-Output ("LIVETEST rule8  available={0}MB  minGB={1}  killOnlyLike=[{2}]" -f $availNow, $min, $like)
  foreach ($j in @(Get-HeavyBatchJobs -MinGB $min)) { Write-Output ("  batch job pid={0} commit={1:N2}GB started={2:HH:mm:ss}" -f $j.Id, $j.GB, $j.Started) }
  $r = 'none'
  if ($like) { $r = Invoke-ConcurrentBatchReclaim -AvailMB $availNow -OnlyCmdLike $like -MinGB $min }
  else { $r = Invoke-ConcurrentBatchReclaim -AvailMB $availNow -DryRun -MinGB $min }
  Write-Output ("LIVETEST rule8 returned '{0}'" -f $r)
  exit 0
}

# ---- rule 9: DEPRIORITIZE heavy node jobs (added 2026-09-11) ----------------------------------
# NON-DESTRUCTIVE, and it runs on healthy RAM too, every poll. Once a node.exe crosses $DeprioMinGB of
# private memory it is set, once, to BelowNormal CPU priority and LOW memory priority:
#   - LOW memory priority puts its pages at the front of the queue Windows repurposes when RAM runs
#     short, so the compositor, Explorer and the graphics driver's user-mode parts keep theirs. The
#     second 2026-09-11 bluescreen was the graphics driver failing to recover for lack of resources.
#   - BelowNormal CPU keeps the desktop responsive while tsc or a compile saturates the cores.
# The job still gets every idle cycle and every free page; it only yields when something else needs
# them. node.exe only - sessions, browsers and editors are untouched.
#
# A NEXT DEV SERVER IS EXEMPT (owner, 2026-09-12) and is RESTORED to Normal CPU / normal memory
# priority if an earlier instance already demoted it. UNLIKE rule 7, the exemption holds even under
# PHX_DEPRIO_LIVETEST_LIKE - deliberately, and that difference is the reason the live check can prove
# it at all: rule 7's live test must stay able to reach a named process because it exists to
# demonstrate a KILL, while rule 9 changes nothing destructive, so there is no reason to let a test
# override the owner's rule. Point PHX_DEPRIO_LIVETEST_LIKE at a dev-server-shaped dummy and it must
# come back untouched, beside a plain dummy that gets demoted.
#
# PROVE IT: PHX_DEPRIO_LIVETEST=1 with PHX_DEPRIO_LIVETEST_LIKE set applies it to matching processes
#           only and prints the priorities read back from the OS (PHX_DEPRIO_MIN_GB for dummies).
$DeprioMinGB        = 1.0
$script:deprioDone  = @{}
$script:deprioCount = 0
$phxPrioSig = @'
using System;
using System.Runtime.InteropServices;
public static class PhxPrio {
  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORY_PRIORITY_INFORMATION { public uint MemoryPriority; }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetProcessInformation(IntPtr hProcess, int infoClass, ref MEMORY_PRIORITY_INFORMATION info, int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetProcessInformation(IntPtr hProcess, int infoClass, ref MEMORY_PRIORITY_INFORMATION info, int size);
  // infoClass 0 = ProcessMemoryPriority; MemoryPriority 2 = MEMORY_PRIORITY_LOW, 5 = normal
  public static bool SetLow(IntPtr h) { MEMORY_PRIORITY_INFORMATION i = new MEMORY_PRIORITY_INFORMATION(); i.MemoryPriority = 2; return SetProcessInformation(h, 0, ref i, 4); }
  // Added 2026-09-12 with the dev-server exemption: a server demoted by an EARLIER instance of this
  // script would otherwise stay demoted for its whole life, because rule 9 only ever set priority DOWN.
  public static bool SetNormal(IntPtr h) { MEMORY_PRIORITY_INFORMATION i = new MEMORY_PRIORITY_INFORMATION(); i.MemoryPriority = 5; return SetProcessInformation(h, 0, ref i, 4); }
  public static int Get(IntPtr h) { MEMORY_PRIORITY_INFORMATION i = new MEMORY_PRIORITY_INFORMATION(); return GetProcessInformation(h, 0, ref i, 4) ? (int)i.MemoryPriority : -1; }
}
'@
$script:PrioAvailable = $true
try { if (-not ('PhxPrio' -as [type])) { Add-Type -TypeDefinition $phxPrioSig -ErrorAction Stop } }
catch { $script:PrioAvailable = $false }

function Invoke-HeavyJobDeprioritize {
  # Rule 9. Returns how many processes it adjusted on this call.
  param([object[]]$Procs, [string]$OnlyCmdLike = '', [double]$MinGB = $DeprioMinGB)
  $live = @{}
  foreach ($p in $Procs) { if ($p.ProcessName -eq 'node') { $live[$p.Id] = $true } }
  foreach ($k in @($script:deprioDone.Keys)) { if (-not $live.ContainsKey($k)) { $script:deprioDone.Remove($k) } }
  $n = 0
  foreach ($p in $Procs) {
    if ($p.ProcessName -ne 'node' -or $p.Id -le 4) { continue }
    if ($script:deprioDone.ContainsKey($p.Id)) { continue }
    $gb = 0.0
    try { $gb = $p.PM / 1GB } catch { continue }
    if ($gb -lt $MinGB) { continue }
    # OWNER EXEMPTION 2026-09-12. Placed AFTER the size gate on purpose: only a node process already
    # over $DeprioMinGB costs a CIM lookup, and the done-set below means that lookup happens once per
    # pid per LIFETIME, not once per 3-second poll.
    if (Test-DevServerExempt -ProcId $p.Id) {
      $script:deprioDone[$p.Id] = $true
      $cpuUp = $false
      $memUp = $false
      try {
        if ($p.PriorityClass -ne [System.Diagnostics.ProcessPriorityClass]::Normal) {
          $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Normal
          $cpuUp = $true
        }
      } catch {}
      try {
        if ($script:PrioAvailable -and ([PhxPrio]::Get($p.Handle) -ne 5)) { $memUp = [PhxPrio]::SetNormal($p.Handle) }
      } catch {}
      if ($cpuUp -or $memUp) {
        Write-Log ("RESTORE pid={0} node commit={1:N2}GB -> cpu Normal={2}, memory priority normal={3} (rule 9 exemption; a previous instance had demoted it)" -f $p.Id, $gb, $cpuUp, $memUp)
      } else {
        Write-DevExemptSkip -ProcId $p.Id -Rule 'rule 9 (deprioritize)'
      }
      continue
    }
    if ($OnlyCmdLike -and ((Get-CommandLineFor -ProcId $p.Id) -notlike $OnlyCmdLike)) { continue }
    $script:deprioDone[$p.Id] = $true      # mark first: a process we cannot adjust is not retried every poll
    $cpuOk = $false
    $memOk = $false
    try { $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal; $cpuOk = $true } catch {}
    try { if ($script:PrioAvailable) { $memOk = [PhxPrio]::SetLow($p.Handle) } } catch {}
    if ($cpuOk -or $memOk) {
      $n++
      $script:deprioCount++
      if ($script:deprioCount -le 3 -or ($script:deprioCount % 25) -eq 0 -or $OnlyCmdLike) {
        $tag = ''
        if ($OnlyCmdLike) { $tag = ' [LIVETEST]' }
        Write-Log ("DEPRIO{0} pid={1} node commit={2:N2}GB -> cpu BelowNormal={3}, memory priority LOW={4} (rule 9; {5} adjusted this run)" -f $tag, $p.Id, $gb, $cpuOk, $memOk, $script:deprioCount)
      }
    }
  }
  return $n
}

# ---- rule 9 live check (added 2026-09-11) --------------------------------------
if ($env:PHX_DEPRIO_LIVETEST) {
  $like = [string]$env:PHX_DEPRIO_LIVETEST_LIKE
  $min = $DeprioMinGB
  if ($env:PHX_DEPRIO_MIN_GB) { try { $min = [double]$env:PHX_DEPRIO_MIN_GB } catch {} }
  Write-Output ("LIVETEST rule9  minGB={0}  onlyLike=[{1}]  memoryPriorityApi={2}" -f $min, $like, $script:PrioAvailable)
  if (-not $like) { Write-Output 'LIVETEST rule9 needs PHX_DEPRIO_LIVETEST_LIKE - it will not touch real processes from a test'; exit 1 }
  $procsNow = @(Get-Process -ErrorAction SilentlyContinue)
  $adjusted = Invoke-HeavyJobDeprioritize -Procs $procsNow -OnlyCmdLike $like -MinGB $min
  Write-Output ("LIVETEST rule9 adjusted {0} process(es)" -f $adjusted)
  foreach ($p in ($procsNow | Where-Object { $_.ProcessName -eq 'node' })) {
    $cl = Get-CommandLineFor -ProcId $p.Id
    if ($cl -like '*dummy*') {
      $p.Refresh()
      Write-Output ("  pid={0} cpuPriority={1} memoryPriority={2} (2 = LOW, 5 = normal) | {3}" -f $p.Id, $p.PriorityClass, [PhxPrio]::Get($p.Handle), $cl)
    }
  }
  exit 0
}

# ---- rule 10: CLAUDE FIRST (owner, 2026-09-12 23:40) ----------------------------------------------
# The owner's words: "I want Claude prioritized in my RAM. I want the first performance." This laptop
# cannot get more RAM (Alienware m17 R2, both 8 GB modules soldered), and Windows has no way to RESERVE
# RAM for one app - so the only lever is deciding who LOSES memory first when it runs short. Measured
# 23:3x: programs asked for 24.3 GB of a 16 GB machine; Edge alone held 2.8-5.4 GB with ONE window.
#
# NON-DESTRUCTIVE, every $ClaudeFirstEverySec, healthy RAM included. Nothing is ever killed here.
#   - CLAUDE FAMILY (every claude.exe, and the shells it spawned): memory priority held at NORMAL (5),
#     and Windows power throttling switched OFF (HighQoS), so an unfocused Claude window is never put
#     into Efficiency mode. Rule 0 no longer trims them either, except under the crash floor.
#   - BACKGROUND APPS ($ClaudeFirstDemote - browsers, ChatGPT, sync clients, helpers): memory priority
#     LOW (2). Windows trims and repurposes LOW pages FIRST, so under pressure Edge loses its pages
#     before Claude loses one. The app in the FOREGROUND is restored to normal while you use it, and
#     demoted again when you leave it - so the tab you are reading does not stutter.
# node.exe is deliberately not on either list: a heavy node job stays rule 9's, a dev server the
# owner's exemption's.
#
# OFF SWITCH: PHX_CLAUDE_FIRST=0 in the task's environment (restores the pre-23:40 behaviour of rule 0).
# PROVE IT:   PHX_CLAUDE_FIRST_LIVETEST=1 applies one pass to the real process table, prints each group's
#             memory priority BEFORE and AFTER as read back from the OS, asserts rule 0 would trim ZERO
#             Claude processes, and exits. Run it again with PHX_CLAUDE_FIRST=0 and the same assertion
#             must go FAIL - that is the negative control.
$ClaudeFirstEnabled = $true
if ($env:PHX_CLAUDE_FIRST -eq '0') { $ClaudeFirstEnabled = $false }
$ClaudeFirstEverySec = 15
$ClaudeFamilyScanSec = 60     # the parent-chain scan is a CIM query - once a minute, not every poll
$ClaudeFirstDemote = @(
  'msedge','msedgewebview2','chrome','firefox','brave','ChatGPT*','Notion*','slack','*Teams*',
  'WhatsApp*','Telegram','Discord','Zoom','Spotify','OneDrive*','GoogleDriveFS','IDMan','FileJuggler*',
  'Everything','ShareX','SnippingTool','WidgetBoard','SystemSettings','Dell.*'
)
$ClaudeShellNames = @('powershell.exe','pwsh.exe','bash.exe','sh.exe','conhost.exe','cmd.exe','OpenConsole.exe')
$script:claudeFamily     = $null
$script:claudeFamilyAt   = [datetime]::MinValue
$script:cfLastRun        = [datetime]::MinValue
$script:cfLastLog        = [datetime]::MinValue
$script:cfDemoted        = @{}   # pid -> demoted by US, so only those are restored in the foreground
$script:cfQosDone        = @{}
$script:cfForegroundName = ''
$script:trimClaudeSpared = 0

$phxQosSig = @'
using System;
using System.Runtime.InteropServices;
public static class PhxQos {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_POWER_THROTTLING_STATE { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetProcessInformation(IntPtr hProcess, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, int size);
  // infoClass 4 = ProcessPowerThrottling. ControlMask EXECUTION_SPEED (1) with StateMask 0 = HighQoS:
  // Windows may not put this process into EcoQoS / Efficiency mode.
  public static bool HighQos(IntPtr h) { PROCESS_POWER_THROTTLING_STATE s = new PROCESS_POWER_THROTTLING_STATE(); s.Version = 1; s.ControlMask = 1; s.StateMask = 0; return SetProcessInformation(h, 4, ref s, 12); }
}
'@
$script:QosAvailable = $true
try { if (-not ('PhxQos' -as [type])) { Add-Type -TypeDefinition $phxQosSig -ErrorAction Stop } }
catch { $script:QosAvailable = $false }

function Get-ClaudeFamilyPids {
  # Every claude.exe (desktop app AND session engines share the name), plus any shell whose parent
  # chain reaches one. Returns a pid set; an unreadable process table returns an EMPTY set, which
  # fails open to the pre-23:40 behaviour rather than guessing.
  $all = @{}
  try {
    foreach ($w in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name -ErrorAction Stop)) { $all[[int]$w.ProcessId] = $w }
  } catch { return @{} }
  $fam = @{}
  foreach ($w in $all.Values) {
    if ($w.Name -eq 'claude.exe') { $fam[[int]$w.ProcessId] = $true; continue }
    if ($ClaudeShellNames -notcontains $w.Name) { continue }
    $cur = $w
    for ($depth = 0; $depth -lt 6; $depth++) {
      $par = $all[[int]$cur.ParentProcessId]
      if (-not $par -or [int]$par.ProcessId -eq [int]$cur.ProcessId) { break }
      if ($par.Name -eq 'claude.exe') { $fam[[int]$w.ProcessId] = $true; break }
      $cur = $par
    }
  }
  return $fam
}

function Get-ClaudeFamilyCached {
  if ($null -eq $script:claudeFamily -or ((Get-Date) - $script:claudeFamilyAt).TotalSeconds -ge $ClaudeFamilyScanSec) {
    $script:claudeFamily = Get-ClaudeFamilyPids
    $script:claudeFamilyAt = Get-Date
  }
  return $script:claudeFamily
}

function Test-ClaudeFirstDemotable {
  param([string]$Name)
  foreach ($pat in $ClaudeFirstDemote) { if ($Name -like $pat) { return $true } }
  return $false
}

function Invoke-ClaudeFirst {
  # Rule 10. Returns @(claudeRaised, appsDemoted, foregroundRestored). Terminates nothing.
  param([object[]]$Procs)
  if (-not $ClaudeFirstEnabled -or -not $script:PrioAvailable) { return @(0, 0, 0) }
  $fam = Get-ClaudeFamilyCached
  $fgPid = 0
  try { [void][PhxWs]::GetWindowThreadProcessId([PhxWs]::GetForegroundWindow(), [ref]$fgPid) } catch {}
  $fgName = ''
  foreach ($p in $Procs) { if ($p.Id -eq $fgPid) { $fgName = $p.ProcessName; break } }
  $script:cfForegroundName = $fgName
  $live = @{}
  $up = 0; $down = 0; $restored = 0
  foreach ($p in $Procs) {
    if ($p.Id -le 4 -or $p.Id -eq $PID) { continue }
    $live[$p.Id] = $true
    $isClaude = $fam.ContainsKey($p.Id)
    if (-not $isClaude -and -not (Test-ClaudeFirstDemotable -Name $p.ProcessName)) { continue }
    try {
      $h = $p.Handle
      $cur = [PhxPrio]::Get($h)
      if ($cur -lt 0) { continue }
      if ($isClaude) {
        if ($cur -lt 5 -and [PhxPrio]::SetNormal($h)) { $up++ }
        if ($script:QosAvailable -and -not $script:cfQosDone.ContainsKey($p.Id)) {
          $script:cfQosDone[$p.Id] = $true
          [void][PhxQos]::HighQos($h)
        }
      } elseif ($fgName -and $p.ProcessName -eq $fgName) {
        if ($script:cfDemoted.ContainsKey($p.Id)) {
          $script:cfDemoted.Remove($p.Id)
          if ($cur -eq 2 -and [PhxPrio]::SetNormal($h)) { $restored++ }
        }
      } elseif ($cur -gt 2) {
        if ([PhxPrio]::SetLow($h)) { $script:cfDemoted[$p.Id] = $true; $down++ }
      }
    } catch {}   # a process we may not open (a SYSTEM service, a protected process) is simply skipped
  }
  foreach ($k in @($script:cfDemoted.Keys)) { if (-not $live.ContainsKey($k)) { $script:cfDemoted.Remove($k) } }
  foreach ($k in @($script:cfQosDone.Keys)) { if (-not $live.ContainsKey($k)) { $script:cfQosDone.Remove($k) } }
  return @($up, $down, $restored)
}

# ---- rule 10 live check (added 2026-09-12) --------------------------------------
if ($env:PHX_CLAUDE_FIRST_LIVETEST) {
  $fam = Get-ClaudeFamilyPids
  $script:claudeFamily = $fam
  $script:claudeFamilyAt = Get-Date
  Write-Output ("LIVETEST rule10  enabled={0}  memoryPriorityApi={1}  qosApi={2}  available={3}MB  claudeFamily={4}" -f $ClaudeFirstEnabled, $script:PrioAvailable, $script:QosAvailable, (Get-AvailableMB), $fam.Count)
  $procsNow = @(Get-Process -ErrorAction SilentlyContinue)
  $before = @{}
  foreach ($p in $procsNow) {
    if ($fam.ContainsKey($p.Id) -or (Test-ClaudeFirstDemotable -Name $p.ProcessName)) {
      try { $before[$p.Id] = [PhxPrio]::Get($p.Handle) } catch { $before[$p.Id] = -1 }
    }
  }
  $r = Invoke-ClaudeFirst -Procs $procsNow
  Write-Output ("LIVETEST rule10 pass: raised {0} Claude, demoted {1} background, restored {2} (foreground app: '{3}')" -f $r[0], $r[1], $r[2], $script:cfForegroundName)
  foreach ($g in ($procsNow | Where-Object { $before.ContainsKey($_.Id) } | Group-Object { if ($fam.ContainsKey($_.Id)) { 'CLAUDE ' + $_.ProcessName } else { 'app    ' + $_.ProcessName } })) {
    $b = @($g.Group | ForEach-Object { $before[$_.Id] }) | Group-Object | ForEach-Object { "{0}:{1}" -f $_.Name, $_.Count }
    $a = @($g.Group | ForEach-Object { try { [PhxPrio]::Get($_.Handle) } catch { -1 } }) | Group-Object | ForEach-Object { "{0}:{1}" -f $_.Name, $_.Count }
    Write-Output ("  {0,-34} x{1,-3} priority:count before [{2}]  after [{3}]" -f $g.Name, $g.Count, ($b -join ' '), ($a -join ' '))
  }
  $cands = Invoke-WorkingSetTrim -ListOnly
  $claudeBig = @($procsNow | Where-Object { $fam.ContainsKey($_.Id) -and ($_.PrivateMemorySize64 / 1MB) -ge $TrimMinPrivateMB }).Count
  $leak = @($cands | Where-Object { $fam.ContainsKey($_.Id) }).Count
  $verdict = if ($leak -eq 0 -and $claudeBig -gt 0) { 'PASS' } else { 'FAIL' }
  Write-Output ("LIVETEST rule10 ASSERT rule 0 trims no Claude process: {0}  ({1} of {2} trim-sized Claude processes are trim candidates; {3} candidates in all)" -f $verdict, $leak, $claudeBig, @($cands).Count)
  exit $(if ($verdict -eq 'PASS') { 0 } else { 1 })
}

# ---- rules 11 + 12: CLOSE an app nobody is using (owner, 2026-09-13) ----------------------------------
# Rule 11 - ChatGPT desktop, after 30 minutes unused. The owner chose "Close after 30 min unused" (00:10 Cairo),
#   knowing chats live in the OpenAI account, a typed-but-unsent message does not survive, and reopening takes ~2s.
#   Measured then: 1.2 GB private, 1,012 MB of it in ONE renderer, window open behind others, already LOW (rule 10).
# Rule 12 - new Outlook, after 30 minutes unused AND ONLY WHILE free RAM is under 2,600 MB. The owner chose "Close
#   only when RAM is low" (00:16 Cairo) over closing it always, because a closed Outlook raises no new-mail alert and
#   no reminder for the work mailboxes. Measured then: 831 MB private 24 minutes after it started, ~190 MB of it in
#   RAM, its web engine (msedgewebview2) already LOW under rule 10. Mail lives on the server, so nothing is lost.
#   It is NOT reopened afterwards - he reopens it when he wants it.
#
# "UNUSED" means BOTH: its window has not been the foreground window, AND it has not been working - more than
# BusyCpuSec CPU-seconds in a minute (a ChatGPT reply streaming, Outlook sending). Outlook's bar is higher because
# its background mail sync alone would otherwise keep it "busy" forever. The clock starts when this watchdog
# starts, so a restart never closes anything on the spot.
#
# HOW IT CLOSES: politely first, exactly like its X button (CloseMainWindow). If it is still running
# $IdleQuitGraceSec later - both apps can hide to the tray instead of quitting - its main process is made to quit
# (its helpers, Outlook's web engine included, exit with it). Coming back to the window during that grace cancels it.
# Only processes carrying the app's OWN name are ever stopped - never a msedgewebview2 by parentage, because a
# reused parent pid could otherwise point at another app's web engine.
#
# 'ChatGPT Classic' STAYS on $Protected, and olk is on no kill list: the generic size-based KILL rules must still
# never pick either. These two rules are the owner's explicit exceptions, and nothing else uses them.
#
# OFF SWITCHES: PHX_CHATGPT_IDLE_CLOSE_MIN=0 / PHX_OUTLOOK_IDLE_CLOSE_MIN=0 (or another number of minutes);
#               PHX_OUTLOOK_CLOSE_BELOW_MB changes Outlook's RAM condition.
# PROVE IT:     PHX_IDLE_CLOSE_SELFTEST=1 asserts the decision offline (table-driven) and exits.
#               PHX_IDLE_CLOSE_LIVETEST=1 runs one DRY pass per app on the real process table as if it had been
#               unused past the limit with RAM low, prints what it would do, and exits. It closes nothing.
$IdleQuitGraceSec = 30
$IdleApps = @(
  @{ Rule = 11; Label = 'ChatGPT'; Like = 'ChatGPT*'; Wql = "Name LIKE 'ChatGPT%'"; Children = $false; LimitMin = 30; BusyCpuSec = 3.0;  BelowMB = 0 }
  @{ Rule = 12; Label = 'Outlook'; Like = 'olk';      Wql = "Name = 'olk.exe'";     Children = $true;  LimitMin = 30; BusyCpuSec = 15.0; BelowMB = 2600 }
)
if ($env:PHX_CHATGPT_IDLE_CLOSE_MIN) { try { $IdleApps[0].LimitMin = [int]$env:PHX_CHATGPT_IDLE_CLOSE_MIN } catch {} }
if ($env:PHX_OUTLOOK_IDLE_CLOSE_MIN) { try { $IdleApps[1].LimitMin = [int]$env:PHX_OUTLOOK_IDLE_CLOSE_MIN } catch {} }
if ($env:PHX_OUTLOOK_CLOSE_BELOW_MB) { try { $IdleApps[1].BelowMB  = [int]$env:PHX_OUTLOOK_CLOSE_BELOW_MB } catch {} }
foreach ($a in $IdleApps) {
  $a.LastUsed = Get-Date; $a.CpuMark = $null; $a.CpuMarkAt = [datetime]::MinValue
  $a.CloseAt = $null; $a.FamilyIds = @{}; $a.FamilyAt = [datetime]::MinValue
}

function Update-IdleAppLastUsed {
  # Pure. Returns the new "last used" time: now if it is in the foreground or working, else unchanged.
  param([datetime]$LastUsed, [datetime]$Now, [bool]$IsForeground, [double]$CpuDelta, [double]$BusyCpuSec)
  if ($IsForeground -or $CpuDelta -ge $BusyCpuSec) { return $Now }
  return $LastUsed
}

function Test-IdleAppShouldClose {
  # Pure. True only when it is running, the rule is on, the unused time has reached the limit, and - when the app
  # has a RAM condition (BelowMB > 0) - free RAM is under it.
  param([datetime]$LastUsed, [datetime]$Now, [double]$MinutesLimit, [bool]$Running, [double]$AvailMB, [double]$BelowMB)
  if (-not $Running -or $MinutesLimit -le 0) { return $false }
  if ($BelowMB -gt 0 -and $AvailMB -ge $BelowMB) { return $false }
  return (($Now - $LastUsed).TotalMinutes -ge $MinutesLimit)
}

function Get-IdleAppFamilyIds {
  # The app's own processes plus every descendant (Outlook's web engine runs as msedgewebview2 under olk).
  param([hashtable]$App, [object[]]$Own)
  $ids = @{}
  foreach ($o in $Own) { $ids[[int]$o.Id] = $true }
  if (-not $App.Children) { return $ids }
  $kids = @{}
  foreach ($c in @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)) {
    $pp = [int]$c.ParentProcessId
    if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }
    [void]$kids[$pp].Add([int]$c.ProcessId)
  }
  $queue = New-Object System.Collections.Queue
  foreach ($k in @($ids.Keys)) { $queue.Enqueue($k) }
  while ($queue.Count) {
    $n = $queue.Dequeue()
    if ($kids.ContainsKey($n)) { foreach ($k in $kids[$n]) { if (-not $ids.ContainsKey($k)) { $ids[$k] = $true; $queue.Enqueue($k) } } }
  }
  return $ids
}

function Invoke-IdleAppClose {
  # Rules 11 + 12. Returns a short status word; 'close-sent' and 'quit' are the only ones that act.
  param([hashtable]$App, [object[]]$Procs, [switch]$DryRun)
  if ($App.LimitMin -le 0) { return 'off' }
  $now = Get-Date
  $own = @($Procs | Where-Object { $_.ProcessName -like $App.Like })
  if (-not $own.Count) {
    $App.LastUsed = $now; $App.CpuMark = $null; $App.CloseAt = $null; $App.FamilyIds = @{}
    return 'not running'
  }
  if (($now - $App.FamilyAt).TotalSeconds -ge 60 -or $App.FamilyIds.Count -eq 0) {
    $App.FamilyIds = Get-IdleAppFamilyIds -App $App -Own $own; $App.FamilyAt = $now
  }
  $fam = @($Procs | Where-Object { $App.FamilyIds.ContainsKey([int]$_.Id) })
  if (-not $fam.Count) { $fam = $own }
  [uint32]$fgPid = 0
  try { [void][PhxWs]::GetWindowThreadProcessId([PhxWs]::GetForegroundWindow(), [ref]$fgPid) } catch {}
  $isFg = ($fgPid -ne 0) -and ($App.FamilyIds.ContainsKey([int]$fgPid) -or @($own | Where-Object { $_.Id -eq $fgPid }).Count -gt 0)
  $cpu = 0.0
  foreach ($g in $fam) { try { $cpu += [double]$g.CPU } catch {} }
  $cpuDelta = 0.0
  if ($null -eq $App.CpuMark -or $cpu -lt $App.CpuMark) {
    $App.CpuMark = $cpu; $App.CpuMarkAt = $now
  } elseif (($now - $App.CpuMarkAt).TotalSeconds -ge 60) {
    $cpuDelta = $cpu - $App.CpuMark; $App.CpuMark = $cpu; $App.CpuMarkAt = $now
  }
  if (-not $DryRun) {
    $App.LastUsed = Update-IdleAppLastUsed -LastUsed $App.LastUsed -Now $now -IsForeground $isFg -CpuDelta $cpuDelta -BusyCpuSec $App.BusyCpuSec
  }
  $mb = [math]::Round((($fam | Measure-Object PrivateMemorySize64 -Sum).Sum) / 1MB)

  if ($null -ne $App.CloseAt) {
    if ($isFg) {
      $App.CloseAt = $null
      Write-Log ("CLOSE-IDLE {0} came back to the foreground during the close - left running (rule {1})" -f $App.Label, $App.Rule)
      return 'in use'
    }
    if (($now - $App.CloseAt).TotalSeconds -lt $IdleQuitGraceSec) { return 'closing' }
    # The polite close did not end it (it hid to the tray). Quit the main process; its helpers exit with it.
    $ownIds = @{}; foreach ($g in $own) { $ownIds[[int]$g.Id] = $true }
    $mains = @(Get-CimInstance Win32_Process -Filter $App.Wql -ErrorAction SilentlyContinue | Where-Object { -not $ownIds.ContainsKey([int]$_.ParentProcessId) })
    foreach ($m in $mains) { try { Stop-Process -Id $m.ProcessId -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Milliseconds 1500
    foreach ($g in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like $App.Like })) { try { Stop-Process -Id $g.Id -Force -ErrorAction Stop } catch {} }
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like $App.Like }).Count
    Write-Log ("CLOSE-IDLE {0} was still running {1}s after the polite close (hidden to the tray) - made it quit; {2} {0} processes left, ~{3} MB freed (rule {4})" -f $App.Label, $IdleQuitGraceSec, $left, $mb, $App.Rule)
    $App.CloseAt = $null; $App.LastUsed = $now; $script:killCount++
    return 'quit'
  }

  if ($DryRun -and $isFg) { return 'dryrun-in-use (foreground)' }
  $lastUsedForDecision = $App.LastUsed
  if ($DryRun) { $lastUsedForDecision = $now.AddMinutes(-($App.LimitMin + 1)) }
  # Free RAM is read only once the time condition is met, so an app in use costs no RAM query per poll.
  if (($now - $lastUsedForDecision).TotalMinutes -lt $App.LimitMin) { return 'in use' }
  $avail = 0
  if ($App.BelowMB -gt 0) { $avail = Get-AvailableMB }
  $availForDecision = $avail
  if ($DryRun -and $App.BelowMB -gt 0) { $availForDecision = $App.BelowMB - 1 }
  if (Test-IdleAppShouldClose -LastUsed $lastUsedForDecision -Now $now -MinutesLimit $App.LimitMin -Running $true -AvailMB $availForDecision -BelowMB $App.BelowMB) {
    $ramNote = ''
    if ($App.BelowMB -gt 0) { $ramNote = (", free RAM {0} MB under {1} MB" -f $avail, $App.BelowMB) }
    if ($DryRun) { return ("dryrun-would-close ({0} processes, {1} MB, window handle present={2}; real free RAM now {3} MB)" -f $fam.Count, $mb, (@($own | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0), (Get-AvailableMB)) }
    $sent = $false
    foreach ($g in $own) { if ($g.MainWindowHandle -ne 0) { try { if ($g.CloseMainWindow()) { $sent = $true } } catch {} } }
    Write-Log ("CLOSE-IDLE {0} unused {1:N0} min (last used {2:HH:mm} Cairo), {3} MB{4} - polite close sent={5}, like its X button; it is made to quit in {6}s if it hides to the tray (rule {7}, owner 2026-09-13)" -f $App.Label, ($now - $App.LastUsed).TotalMinutes, $App.LastUsed, $mb, $ramNote, $sent, $IdleQuitGraceSec, $App.Rule)
    $App.CloseAt = $now
    return 'close-sent'
  }
  return 'unused, RAM fine'
}

# ---- rules 11 + 12 self-test (added 2026-09-13) ----------------------------------
if ($env:PHX_IDLE_CLOSE_SELFTEST) {
  $t = Get-Date
  $cases = @(
    @{ Name = 'ChatGPT in the foreground now          '; Last = $t.AddMinutes(-90); Fg = $true;  Cpu = 0;  Busy = 3;  Lim = 30; Run = $true;  Avail = 9000; Below = 0;    Want = $false }
    @{ Name = 'ChatGPT background 31 min, quiet       '; Last = $t.AddMinutes(-31); Fg = $false; Cpu = 0;  Busy = 3;  Lim = 30; Run = $true;  Avail = 9000; Below = 0;    Want = $true  }
    @{ Name = 'ChatGPT background 29 min, quiet       '; Last = $t.AddMinutes(-29); Fg = $false; Cpu = 0;  Busy = 3;  Lim = 30; Run = $true;  Avail = 9000; Below = 0;    Want = $false }
    @{ Name = 'ChatGPT background 31 min, still busy  '; Last = $t.AddMinutes(-31); Fg = $false; Cpu = 10; Busy = 3;  Lim = 30; Run = $true;  Avail = 9000; Below = 0;    Want = $false }
    @{ Name = 'ChatGPT not running                    '; Last = $t.AddMinutes(-99); Fg = $false; Cpu = 0;  Busy = 3;  Lim = 30; Run = $false; Avail = 9000; Below = 0;    Want = $false }
    @{ Name = 'ChatGPT rule switched off (0 minutes)  '; Last = $t.AddMinutes(-99); Fg = $false; Cpu = 0;  Busy = 3;  Lim = 0;  Run = $true;  Avail = 9000; Below = 0;    Want = $false }
    @{ Name = 'Outlook unused 31 min, RAM fine (3000) '; Last = $t.AddMinutes(-31); Fg = $false; Cpu = 0;  Busy = 15; Lim = 30; Run = $true;  Avail = 3000; Below = 2600; Want = $false }
    @{ Name = 'Outlook unused 31 min, RAM low (2000)  '; Last = $t.AddMinutes(-31); Fg = $false; Cpu = 0;  Busy = 15; Lim = 30; Run = $true;  Avail = 2000; Below = 2600; Want = $true  }
    @{ Name = 'Outlook RAM low but in the foreground  '; Last = $t.AddMinutes(-90); Fg = $true;  Cpu = 0;  Busy = 15; Lim = 30; Run = $true;  Avail = 2000; Below = 2600; Want = $false }
    @{ Name = 'Outlook RAM low but used 29 min ago    '; Last = $t.AddMinutes(-29); Fg = $false; Cpu = 0;  Busy = 15; Lim = 30; Run = $true;  Avail = 2000; Below = 2600; Want = $false }
    @{ Name = 'Outlook RAM low, mail sync 8 cpu-s/min '; Last = $t.AddMinutes(-31); Fg = $false; Cpu = 8;  Busy = 15; Lim = 30; Run = $true;  Avail = 2000; Below = 2600; Want = $true  }
  )
  $fails = 0
  foreach ($c in $cases) {
    $lu = Update-IdleAppLastUsed -LastUsed $c.Last -Now $t -IsForeground $c.Fg -CpuDelta $c.Cpu -BusyCpuSec $c.Busy
    $got = Test-IdleAppShouldClose -LastUsed $lu -Now $t -MinutesLimit $c.Lim -Running $c.Run -AvailMB $c.Avail -BelowMB $c.Below
    $ok = ($got -eq $c.Want)
    if (-not $ok) { $fails++ }
    Write-Output ("SELFTEST idle-close {0}: {1}  close expected={2} got={3}" -f $c.Name, $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.Want, $got)
  }
  Write-Output ("SELFTEST idle-close {0} cases, {1} failed" -f $cases.Count, $fails)
  exit $(if ($fails) { 1 } else { 0 })
}

# ---- rules 11 + 12 live check, DRY RUN (added 2026-09-13) -------------------------
if ($env:PHX_IDLE_CLOSE_LIVETEST) {
  function Write-Log { param([string]$m) Write-Output ("(log) " + $m) }   # never write the real log from a test
  $procsNow = @(Get-Process -ErrorAction SilentlyContinue)
  foreach ($a in $IdleApps) {
    $r = Invoke-IdleAppClose -App $a -Procs $procsNow -DryRun
    Write-Output ("LIVETEST rule{0} {1} limit={2}min belowMB={3}  result: {4}" -f $a.Rule, $a.Label, $a.LimitMin, $a.BelowMB, $r)
  }
  exit 0
}

# ---- rule 13: QUIT OneDrive while RAM is low, START it again when RAM recovers (owner, 2026-09-13) ----------
# The owner chose "Quit only when RAM is low" (00:27 Cairo) over never starting it at sign-in, because OneDrive
# backs up his Desktop, Documents and Pictures (38,059 items) and he wants that backup running most of the time.
# Measured then: OneDrive.exe was not running at all; its "OneDrive Startup Task" (sign-in + 10 min) brings it back
# even though its Task Manager startup entry is disabled.
#
# QUIT:    free RAM under $OdQuitBelowMB on $OdLowChecksNeeded checks in a row (one check every $OdEverySec s, so a
#          sustained dip, never one noisy sample). It is asked to quit the supported way (OneDrive.exe /shutdown) and
#          is NEVER killed: a killed sync engine can stop mid-write in its database. No file is lost; it catches up.
# RESTART: only if THIS rule quit it - a OneDrive he closed himself stays closed - once free RAM has stayed above
#          $OdRestartAboveMB on $OdHighChecksNeeded checks (2 minutes) AND at least $OdMinOffMin minutes have passed,
#          so it cannot flap. Started exactly as sign-in starts it: OneDrive.exe /background.
# The "quit by this rule" flag lives in a file beside this script, so a watchdog restart still restarts OneDrive.
# If OneDrive is seen running again after its shutdown grace (he opened it, or the sign-in task did), the flag clears.
#
# OFF SWITCH: PHX_ONEDRIVE_LOWRAM=0.
# PROVE IT:   PHX_ONEDRIVE_SELFTEST=1 asserts the decision offline (table-driven) and exits.
#             PHX_ONEDRIVE_LIVETEST=1 prints what it would do on the real machine if the condition held, and exits.
#             It starts, stops and writes nothing.
$OdEnabled          = -not ($env:PHX_ONEDRIVE_LOWRAM -eq '0')
$OdEverySec         = 15
$OdQuitBelowMB      = 2600
$OdRestartAboveMB   = 4000
$OdLowChecksNeeded  = 2
$OdHighChecksNeeded = 8
$OdMinOffMin        = 10
$OdShutdownGraceSec = 90
$OdFlagFile         = Join-Path $PSScriptRoot 'mem-watchdog.onedrive-quit.flag'
$script:odLastRun   = [datetime]::MinValue
$script:odLow       = 0
$script:odHigh      = 0

function Get-OneDriveAction {
  # Pure. Returns 'quit', 'restart' or 'none'.
  param([bool]$Running, [bool]$QuitByUs, [int]$LowChecks, [int]$HighChecks, [double]$MinutesSinceQuit)
  if ($Running) {
    if ($LowChecks -ge $OdLowChecksNeeded) { return 'quit' }
    return 'none'
  }
  if ($QuitByUs -and $HighChecks -ge $OdHighChecksNeeded -and $MinutesSinceQuit -ge $OdMinOffMin) { return 'restart' }
  return 'none'
}

function Get-OneDriveExe {
  foreach ($c in @("$env:ProgramFiles\Microsoft OneDrive\OneDrive.exe", "$env:LOCALAPPDATA\Microsoft\OneDrive\OneDrive.exe")) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

function Invoke-OneDriveLowRam {
  # Rule 13. Returns a short status word; 'quit' and 'restart' are the only ones that act.
  param([object[]]$Procs, [switch]$DryRun)
  if (-not $OdEnabled) { return 'off' }
  $now = Get-Date
  $od = @($Procs | Where-Object { $_.ProcessName -eq 'OneDrive' })
  $running = $od.Count -gt 0
  $quitAt = $null
  if (Test-Path -LiteralPath $OdFlagFile) {
    try { $quitAt = [datetime]::Parse((Get-Content -LiteralPath $OdFlagFile -Raw).Trim()) }
    catch { $quitAt = (Get-Item -LiteralPath $OdFlagFile).LastWriteTime }
  }
  if ($quitAt -and $running -and -not $DryRun) {
    if (($now - $quitAt).TotalSeconds -lt $OdShutdownGraceSec) { return 'quitting' }
    Remove-Item -LiteralPath $OdFlagFile -Force -ErrorAction SilentlyContinue
    Write-Log "ONEDRIVE running again (opened by you or at sign-in) - no longer waiting to restart it (rule 13)"
    $quitAt = $null
  }
  $avail = Get-AvailableMB
  if ($avail -lt $OdQuitBelowMB) { $script:odLow++ } else { $script:odLow = 0 }
  if ($avail -gt $OdRestartAboveMB) { $script:odHigh++ } else { $script:odHigh = 0 }
  $sinceQuit = 0.0
  if ($quitAt) { $sinceQuit = ($now - $quitAt).TotalMinutes }
  $low = $script:odLow; $high = $script:odHigh; $byUs = [bool]$quitAt
  if ($DryRun) { $low = $OdLowChecksNeeded; $high = $OdHighChecksNeeded; $sinceQuit = $OdMinOffMin; $byUs = $true }
  $action = Get-OneDriveAction -Running $running -QuitByUs $byUs -LowChecks $low -HighChecks $high -MinutesSinceQuit $sinceQuit
  $exe = Get-OneDriveExe
  $mb = [math]::Round((($od | Measure-Object PrivateMemorySize64 -Sum).Sum) / 1MB)
  if ($DryRun) { return ("dryrun running={0} ({1} MB) freeRAM-now={2}MB  would-do-if-condition-held={3}  exe={4}" -f $running, $mb, $avail, $action, $exe) }

  if ($action -eq 'quit') {
    $script:odLow = 0
    if (-not $exe) { Write-Log "ONEDRIVE free RAM low but OneDrive.exe was not found - nothing done (rule 13)"; return 'no exe' }
    Start-Process -FilePath $exe -ArgumentList '/shutdown' -WindowStyle Hidden
    Set-Content -LiteralPath $OdFlagFile -Value ($now.ToString('o')) -Encoding ASCII
    Write-Log ("ONEDRIVE free RAM {0} MB under {1} MB for {2}s - asked OneDrive to quit (OneDrive.exe /shutdown, not killed), {3} MB; it starts again once free RAM stays above {4} MB (rule 13, owner 2026-09-13)" -f $avail, $OdQuitBelowMB, ($OdLowChecksNeeded * $OdEverySec), $mb, $OdRestartAboveMB)
    return 'quit'
  }
  if ($action -eq 'restart') {
    $script:odHigh = 0
    if (-not $exe) { Write-Log "ONEDRIVE RAM recovered but OneDrive.exe was not found - nothing started (rule 13)"; return 'no exe' }
    Start-Process -FilePath $exe -ArgumentList '/background'
    Remove-Item -LiteralPath $OdFlagFile -Force -ErrorAction SilentlyContinue
    Write-Log ("ONEDRIVE free RAM {0} MB has stayed above {1} MB - started OneDrive again (/background) after {2:N0} min off; it syncs what changed meanwhile (rule 13)" -f $avail, $OdRestartAboveMB, $sinceQuit)
    return 'restart'
  }
  return 'none'
}

# ---- rule 13 self-test (added 2026-09-13) ----------------------------------------
if ($env:PHX_ONEDRIVE_SELFTEST) {
  $cases = @(
    @{ Name = 'running, RAM low for 30s              '; Run = $true;  ByUs = $false; Low = 2; High = 0;  Min = 0;  Want = 'quit' }
    @{ Name = 'running, RAM low on one check only    '; Run = $true;  ByUs = $false; Low = 1; High = 0;  Min = 0;  Want = 'none' }
    @{ Name = 'running, RAM fine                     '; Run = $true;  ByUs = $false; Low = 0; High = 9;  Min = 0;  Want = 'none' }
    @{ Name = 'quit by rule, RAM back 2 min, 11 min  '; Run = $false; ByUs = $true;  Low = 0; High = 8;  Min = 11; Want = 'restart' }
    @{ Name = 'quit by rule, RAM back, only 5 min off'; Run = $false; ByUs = $true;  Low = 0; High = 8;  Min = 5;  Want = 'none' }
    @{ Name = 'quit by rule, RAM back only 45s       '; Run = $false; ByUs = $true;  Low = 0; High = 3;  Min = 30; Want = 'none' }
    @{ Name = 'closed by YOU, RAM fine               '; Run = $false; ByUs = $false; Low = 0; High = 99; Min = 99; Want = 'none' }
  )
  $fails = 0
  foreach ($c in $cases) {
    $got = Get-OneDriveAction -Running $c.Run -QuitByUs $c.ByUs -LowChecks $c.Low -HighChecks $c.High -MinutesSinceQuit $c.Min
    $ok = ($got -eq $c.Want)
    if (-not $ok) { $fails++ }
    Write-Output ("SELFTEST rule13 {0}: {1}  expected={2} got={3}" -f $c.Name, $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.Want, $got)
  }
  Write-Output ("SELFTEST rule13 {0} cases, {1} failed" -f $cases.Count, $fails)
  exit $(if ($fails) { 1 } else { 0 })
}

# ---- rule 13 live check, DRY RUN (added 2026-09-13) -------------------------------
if ($env:PHX_ONEDRIVE_LIVETEST) {
  function Write-Log { param([string]$m) Write-Output ("(log) " + $m) }   # never write the real log from a test
  $r = Invoke-OneDriveLowRam -Procs @(Get-Process -ErrorAction SilentlyContinue) -DryRun
  Write-Output ("LIVETEST rule13 quitBelow={0}MB restartAbove={1}MB flagFile={2}  result: {3}" -f $OdQuitBelowMB, $OdRestartAboveMB, $OdFlagFile, $r)
  exit 0
}

# ---- rule 14: CLOSE the WhatsApp Web app window while RAM is low (owner, 2026-09-13) -------------------------
# The owner chose "Close WhatsApp Web when RAM is low" (00:40 Cairo) over letting the tab sleep or changing nothing.
# Measured then: the WhatsApp desktop app was not running and no WhatsApp Web window was open, but the WhatsApp Web
# app (an Edge web app) had been opened on 2026-09-12 14:11, and the Edge policy set earlier that night keeps
# web.whatsapp.com out of sleeping tabs - so while that window is open it never gives its memory back.
#
# WHAT IT CLOSES: only a visible window owned by msedge whose title is WhatsApp itself ("WhatsApp", "(3) WhatsApp",
# "WhatsApp Business") - that is the web-app window. An ordinary Edge window whose active tab is WhatsApp is titled
# "... - Microsoft Edge" and is NEVER matched: closing it would close every other tab with it. The window is closed
# exactly like its X (WM_CLOSE); Edge is never killed. He reopens WhatsApp himself.
# WHEN: free RAM under $WaCloseBelowMB on $WaLowChecksNeeded checks in a row (one every $WaEverySec s), AND the window
# has not been the foreground window for $WaIdleMin minutes - so it never closes under his hands. Foreground is
# sampled on every 3-second poll; a window first seen by this watchdog counts as used at that moment.
#
# OFF SWITCH: PHX_WHATSAPP_LOWRAM=0.
# PROVE IT:   PHX_WHATSAPP_SELFTEST=1 asserts the title matcher and the decision offline (table-driven) and exits.
#             PHX_WHATSAPP_LIVETEST=1 lists the real Edge windows, which ones match, and what it would do; closes nothing.
$WaEnabled         = -not ($env:PHX_WHATSAPP_LOWRAM -eq '0')
$WaEverySec        = 15
$WaCloseBelowMB    = 2600
$WaLowChecksNeeded = 2
$WaIdleMin         = 5
$script:waLastRun  = [datetime]::MinValue
$script:waLow      = 0
$script:waLastFg   = @{}   # window handle -> last time it was seen in the foreground (or first seen)
$script:waClosedAt = @{}   # window handle -> when WM_CLOSE was posted

$phxWinSig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PhxWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public class Win { public IntPtr Handle; public uint Pid; public string Title; }
  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static List<Win> Visible() {
    List<Win> list = new List<Win>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) { string t = Title(h); if (t.Length > 0) { Win w = new Win(); w.Handle = h; w.Pid = Pid(h); w.Title = t; list.Add(w); } }
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static bool Close(IntPtr h) { return PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }   // WM_CLOSE = its X
}
'@
$script:WinApiAvailable = $true
try { if (-not ('PhxWin' -as [type])) { Add-Type -TypeDefinition $phxWinSig -ErrorAction Stop } }
catch { $script:WinApiAvailable = $false }

function Test-WhatsAppWebTitle {
  # Pure. True only for the web-app window's own title - never a browser window ("... - Microsoft Edge").
  param([string]$Title)
  if ([string]::IsNullOrWhiteSpace($Title)) { return $false }
  if ($Title -match 'Microsoft.Edge') { return $false }
  return ($Title.Trim() -match '^(\(\d+\)\s*)?WhatsApp( Business)?( - WhatsApp( Business)?)?$')
}

function Test-WhatsAppWebShouldClose {
  # Pure. True when RAM has been low long enough AND the window is not in use.
  param([int]$LowChecks, [bool]$IsForeground, [double]$MinutesSinceForeground)
  if ($IsForeground) { return $false }
  if ($LowChecks -lt $WaLowChecksNeeded) { return $false }
  return ($MinutesSinceForeground -ge $WaIdleMin)
}

function Update-WhatsAppWebForeground {
  # Every poll, cheap: one foreground-window lookup. Records when a WhatsApp Web window was last in front.
  param([object[]]$Procs)
  if (-not $script:WinApiAvailable) { return }
  $h = [PhxWin]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return }
  if (-not (Test-WhatsAppWebTitle -Title ([PhxWin]::Title($h)))) { return }
  $fgPid = [PhxWin]::Pid($h)
  if (@($Procs | Where-Object { $_.Id -eq $fgPid -and $_.ProcessName -eq 'msedge' }).Count) { $script:waLastFg[[int64]$h] = Get-Date }
}

function Invoke-WhatsAppWebLowRam {
  # Rule 14. Returns a short status word; 'closed' is the only one that acts.
  param([object[]]$Procs, [switch]$DryRun)
  if (-not $WaEnabled) { return 'off' }
  if (-not $script:WinApiAvailable) { return 'no window api' }
  $now = Get-Date
  $edge = @{}
  foreach ($p in $Procs) { if ($p.ProcessName -eq 'msedge') { $edge[[uint32]$p.Id] = $true } }
  $wins = @([PhxWin]::Visible() | Where-Object { $edge.ContainsKey($_.Pid) -and (Test-WhatsAppWebTitle -Title $_.Title) })
  $live = @{}
  foreach ($w in $wins) { $k = [int64]$w.Handle; $live[$k] = $true; if (-not $script:waLastFg.ContainsKey($k)) { $script:waLastFg[$k] = $now } }
  foreach ($k in @($script:waLastFg.Keys))   { if (-not $live.ContainsKey($k)) { $script:waLastFg.Remove($k) } }
  foreach ($k in @($script:waClosedAt.Keys)) { if (-not $live.ContainsKey($k)) { $script:waClosedAt.Remove($k) } }
  $avail = Get-AvailableMB
  if ($avail -lt $WaCloseBelowMB) { $script:waLow++ } else { $script:waLow = 0 }
  if (-not $wins.Count) { return ("no WhatsApp Web window (free RAM {0} MB)" -f $avail) }
  $fg = [int64][PhxWin]::GetForegroundWindow()
  $done = New-Object System.Collections.ArrayList
  foreach ($w in $wins) {
    $k = [int64]$w.Handle
    $isFg = ($k -eq $fg)
    $idle = ($now - $script:waLastFg[$k]).TotalMinutes
    $low = $script:waLow
    if ($DryRun) { $low = $WaLowChecksNeeded; $idle = $WaIdleMin }
    if (-not (Test-WhatsAppWebShouldClose -LowChecks $low -IsForeground $isFg -MinutesSinceForeground $idle)) {
      [void]$done.Add(("'{0}' kept (foreground={1}, unused {2:N1} min)" -f $w.Title, $isFg, $idle)); continue
    }
    if ($DryRun) { [void]$done.Add(("'{0}' WOULD close if RAM stayed under {1} MB (real free RAM {2} MB)" -f $w.Title, $WaCloseBelowMB, $avail)); continue }
    if ($script:waClosedAt.ContainsKey($k)) {
      if (($now - $script:waClosedAt[$k]).TotalSeconds -ge 60) {
        Write-Log ("WHATSAPP-WEB window '{0}' did not close 60s after its X was sent - left open, not killed (rule 14)" -f $w.Title)
        $script:waClosedAt[$k] = $now.AddYears(1)   # log once per window, never retry-spam
      }
      continue
    }
    $sent = [PhxWin]::Close($w.Handle)
    $script:waClosedAt[$k] = $now
    Write-Log ("WHATSAPP-WEB free RAM {0} MB under {1} MB for {2}s - closed the WhatsApp Web app window '{3}' like its X (sent={4}; not in front for {5:N0} min; Edge and its other tabs untouched). Reopen it from Start or the taskbar (rule 14, owner 2026-09-13)" -f $avail, $WaCloseBelowMB, ($WaLowChecksNeeded * $WaEverySec), $w.Title, $sent, $idle)
    [void]$done.Add('closed')
  }
  if (-not $DryRun -and $done -contains 'closed') { $script:waLow = 0; return 'closed' }
  return ($done -join '; ')
}

# ---- rule 14 self-test (added 2026-09-13) ----------------------------------------
if ($env:PHX_WHATSAPP_SELFTEST) {
  $fails = 0
  $titles = @(
    @{ T = 'WhatsApp';                                                             Want = $true  }
    @{ T = '(3) WhatsApp';                                                         Want = $true  }
    @{ T = 'WhatsApp Business';                                                    Want = $true  }
    @{ T = 'WhatsApp and 19 more pages - Personal - Microsoft' + [char]0x200B + ' Edge'; Want = $false }
    @{ T = 'WhatsApp - Personal - Microsoft Edge';                                 Want = $false }
    @{ T = ('Videos ' + [char]0x00B7 + ' Future Talents Field and 19 more pages - Personal - Microsoft Edge'); Want = $false }
    @{ T = 'WhatsApp Web tutorial - YouTube';                                      Want = $false }
    @{ T = '';                                                                     Want = $false }
  )
  foreach ($c in $titles) {
    $got = Test-WhatsAppWebTitle -Title $c.T
    $ok = ($got -eq $c.Want); if (-not $ok) { $fails++ }
    Write-Output ("SELFTEST rule14 title {0,-62}: {1}  match expected={2} got={3}" -f ("'" + $c.T + "'"), $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.Want, $got)
  }
  $cases = @(
    @{ Name = 'RAM low 30s, not in front 6 min '; Low = 2; Fg = $false; Min = 6;  Want = $true  }
    @{ Name = 'RAM low on one check only       '; Low = 1; Fg = $false; Min = 60; Want = $false }
    @{ Name = 'RAM low, but it is in front     '; Low = 5; Fg = $true;  Min = 60; Want = $false }
    @{ Name = 'RAM low, used 4 min ago         '; Low = 5; Fg = $false; Min = 4;  Want = $false }
    @{ Name = 'RAM fine                        '; Low = 0; Fg = $false; Min = 60; Want = $false }
  )
  foreach ($c in $cases) {
    $got = Test-WhatsAppWebShouldClose -LowChecks $c.Low -IsForeground $c.Fg -MinutesSinceForeground $c.Min
    $ok = ($got -eq $c.Want); if (-not $ok) { $fails++ }
    Write-Output ("SELFTEST rule14 decide {0}: {1}  close expected={2} got={3}" -f $c.Name, $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.Want, $got)
  }
  Write-Output ("SELFTEST rule14 {0} cases, {1} failed" -f ($titles.Count + $cases.Count), $fails)
  exit $(if ($fails) { 1 } else { 0 })
}

# ---- rule 14 live check, DRY RUN (added 2026-09-13) -------------------------------
if ($env:PHX_WHATSAPP_LIVETEST) {
  function Write-Log { param([string]$m) Write-Output ("(log) " + $m) }   # never write the real log from a test
  $procsNow = @(Get-Process -ErrorAction SilentlyContinue)
  $edgeIds = @{}; foreach ($p in $procsNow) { if ($p.ProcessName -eq 'msedge') { $edgeIds[[uint32]$p.Id] = $true } }
  foreach ($w in @([PhxWin]::Visible() | Where-Object { $edgeIds.ContainsKey($_.Pid) })) {
    Write-Output ("LIVETEST rule14 edge window '{0}'  matches WhatsApp Web={1}" -f $w.Title, (Test-WhatsAppWebTitle -Title $w.Title))
  }
  Write-Output ("LIVETEST rule14 windowApi={0}  result: {1}" -f $script:WinApiAvailable, (Invoke-WhatsAppWebLowRam -Procs $procsNow -DryRun))
  exit 0
}

# ---- dev-exemption self-test (added 2026-09-12) -------------------------------
# PLACED HERE ON PURPOSE, not up beside rule 5's self-test where it was first written: one of its
# assertions reads [PhxPrio], the type rule 9 defines with Add-Type ~400 lines below that spot. Up
# there the type does not exist yet, the reference throws, the try/catch swallows it and the case
# reports "SetNormal missing" - a FAILURE INDISTINGUISHABLE from the real defect it tests for. It
# still sits above the single-instance mutex, so it can never disturb the live watchdog.
# Asserts the PREDICATE every rule now calls, table-driven, with NEGATIVE CONTROLS - a table of
# positives alone cannot tell a working predicate from one that returns $true for everything, and
# "everything is exempt" would silently disarm the whole watchdog. Kills nothing; exits.
if ($env:PHX_DEV_EXEMPT_SELFTEST) {
  $cases = @(
    @{ Want = $true;  Why = 'the real server child (holds the gigabytes)'; Cmd = 'C:\Program Files\nodejs\node.exe F:\Phoenix Workforce\phoenix-workforce\node_modules\next\dist\server\lib\start-server.js' },
    @{ Want = $true;  Why = 'the next dev parent';                         Cmd = 'node node_modules/next/dist/bin/next dev --webpack --port 3000' },
    @{ Want = $true;  Why = 'this repo''s own wrapper (pnpm run dev)';     Cmd = 'node F:\Phoenix Workforce\phoenix-workforce\scripts\dev-server.mjs' },
    @{ Want = $true;  Why = 'a long path that a 300-char truncation would cut'; Cmd = ('node ' + ('x' * 320) + ' node_modules\next\dist\server\lib\start-server.js') },
    @{ Want = $false; Why = 'CONTROL: a typecheck must still be killable'; Cmd = 'node node_modules/typescript/bin/tsc --noEmit --incremental false' },
    @{ Want = $false; Why = 'CONTROL: the test suite must still be killable'; Cmd = 'node --experimental-strip-types tests/run-tests.ts' },
    @{ Want = $false; Why = 'CONTROL: eslint must still be killable';      Cmd = 'node node_modules/eslint/bin/eslint.js .' },
    @{ Want = $false; Why = 'CONTROL: an ExcelJS probe - the 22->41GB runaway'; Cmd = 'node C:\Users\satoh\probe-xlsx.mjs' },
    @{ Want = $false; Why = 'CONTROL: a devtools script is not a dev server'; Cmd = 'node F:\repo\scripts\devtools.mjs' },
    @{ Want = $false; Why = 'CONTROL: an unreadable command line';         Cmd = '' }
  )
  $fails = 0
  foreach ($c in $cases) {
    $got = Test-IsDevServerCmdLine -CommandLine $c.Cmd
    $ok = ($got -eq $c.Want)
    if (-not $ok) { $fails++ }
    $shown = $c.Cmd
    if ($shown.Length -gt 72) { $shown = $shown.Substring(0, 34) + ' ... ' + $shown.Substring($shown.Length - 33) }
    Write-Host ("{0}  exempt={1} want={2}  {3}  | {4}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $got, $c.Want, $c.Why, $shown)
  }
  # The switch itself is part of the contract: PHX_DEV_KILL_EXEMPT=0 must make every rule hostile again.
  $saved = $DevServerKillExempt
  $DevServerKillExempt = $false
  $offGot = Test-DevServerExempt -ProcId 0 -CommandLine 'node node_modules/next/dist/server/lib/start-server.js'
  $DevServerKillExempt = $saved
  if ($offGot) { $fails++ }
  Write-Host ("{0}  CONTROL: PHX_DEV_KILL_EXEMPT=0 makes a real dev server killable again (exempt={1}, want=False)" -f $(if (-not $offGot) { 'PASS' } else { 'FAIL' }), $offGot)
  # Rule 9 restores a demoted server, which needs an API that only ever existed to demote one. A
  # missing SetNormal would fail SILENTLY inside its try/catch - the server would simply stay slow,
  # which is indistinguishable from the exemption not being there at all.
  $hasNormal = $false
  try { $hasNormal = $script:PrioAvailable -and ($null -ne ([PhxPrio].GetMethod('SetNormal'))) } catch {}
  if (-not $hasNormal) { $fails++ }
  Write-Host ("{0}  rule 9 can RESTORE priority (PhxPrio::SetNormal present={1}, want=True)" -f $(if ($hasNormal) { 'PASS' } else { 'FAIL' }), $hasNormal)
  # Rule 0's memo is the one piece of state that can go WRONG rather than merely missing: a stale
  # entry for a dead pid would answer for whatever process Windows hands that number to next.
  $script:devExemptCache[999999] = $true
  [void](Get-ExemptDevServerPids)
  $pruned = -not $script:devExemptCache.ContainsKey(999999)
  if (-not $pruned) { $fails++ }
  Write-Host ("{0}  rule 0 memo drops a dead pid rather than answering for its successor (pruned={1}, want=True)" -f $(if ($pruned) { 'PASS' } else { 'FAIL' }), $pruned)
  # The 2026-09-21 re-arm (owner, "Over 8 GB or unused 25 min"), through the SAME function rules 1 and 3
  # call. Controls sit on both sides of each threshold, on the disarm switch, and on the rules that must
  # stay exempt - "stop everything" would pass a table of positives alone.
  $verdicts = @(
    @{ Want = 'stop';  Rule = 'ceiling';  GB = 9.9;     Idle = 0;  C = $true;  I = $true;  Why = 'rule 1: the 9.9 GB redirect-loop runaway of 2026-09-21' },
    @{ Want = 'stop';  Rule = 'ceiling';  GB = $KillGB; Idle = 0;  C = $true;  I = $true;  Why = 'rule 1: exactly at the ceiling' },
    @{ Want = 'spare'; Rule = 'ceiling';  GB = 7.3;     Idle = 0;  C = $true;  I = $true;  Why = 'CONTROL rule 1: a busy healthy server at 7.3 GB' },
    @{ Want = 'spare'; Rule = 'ceiling';  GB = 9.9;     Idle = 0;  C = $false; I = $true;  Why = 'CONTROL rule 1: PHX_DEV_RUNAWAY_STOP=0 spares a runaway' },
    @{ Want = 'stop';  Rule = 'idle';     GB = 5.0;     Idle = 25; C = $true;  I = $true;  Why = 'rule 3: no work for 25 min, holding 5 GB' },
    @{ Want = 'spare'; Rule = 'idle';     GB = 5.0;     Idle = 24; C = $true;  I = $true;  Why = 'CONTROL rule 3: 24 min is still inside the window' },
    @{ Want = 'spare'; Rule = 'idle';     GB = 0.07;    Idle = 90; C = $true;  I = $true;  Why = 'CONTROL rule 3: the 0.07 GB next dev parent is never worth it' },
    @{ Want = 'spare'; Rule = 'idle';     GB = 5.0;     Idle = 90; C = $true;  I = $false; Why = 'CONTROL rule 3: PHX_DEV_RUNAWAY_STOP=0 spares an idle one' },
    @{ Want = 'spare'; Rule = 'ram';      GB = 9.9;     Idle = 90; C = $true;  I = $true;  Why = 'CONTROL: rule 4 (physical RAM) keeps the exemption' },
    @{ Want = 'spare'; Rule = 'critical'; GB = 9.9;     Idle = 90; C = $true;  I = $true;  Why = 'CONTROL: rule 7 (critical RAM) keeps the exemption' }
  )
  foreach ($v in $verdicts) {
    $got = Get-DevServerVerdict -Rule $v.Rule -GB $v.GB -IdleMin $v.Idle -CeilingArmed $v.C -IdleArmed $v.I
    $ok = ($got -eq $v.Want)
    if (-not $ok) { $fails++ }
    Write-Host ("{0}  verdict={1} want={2}  {3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $got, $v.Want, $v.Why)
  }
  # The loop calls it WITHOUT the flags, so the shipped defaults must be armed - a table that always
  # passes its flags explicitly would stay green with the live switch left off.
  $live = Get-DevServerVerdict -Rule 'ceiling' -GB 9.9
  if ($live -ne 'stop') { $fails++ }
  Write-Host ("{0}  the LIVE config is armed: a 9.9 GB dev server with default flags gets verdict={1}, want=stop" -f $(if ($live -eq 'stop') { 'PASS' } else { 'FAIL' }), $live)

  # ---- rule 15 (owner, 2026-10-29): the pressure guard, through the SAME four functions the loop calls.
  # Every threshold is tested on BOTH sides, and every positive has a control that differs in one input.
  $p15n = 0
  $p15 = @(
    @{ Want = 'stop'; Warn = 30;   Thrash = 30;   Floor = 0;    A = $true;  Why = 'rule 15: paging hard under 500 MB for exactly 30 s' },
    @{ Want = 'warn'; Warn = 29.9; Thrash = 29.9; Floor = 0;    A = $true;  Why = 'CONTROL rule 15: 29.9 s of paging is still inside the window - log only' },
    @{ Want = 'stop'; Warn = 15;   Thrash = 0;    Floor = 15;   A = $true;  Why = 'rule 15: under 300 MB for exactly 15 s, paging or not' },
    @{ Want = 'spare'; Warn = 14.9; Thrash = 0;   Floor = 14.9; A = $true;  Why = 'CONTROL rule 15: 14.9 s under 300 MB is still inside the window' },
    @{ Want = 'warn'; Warn = 15;   Thrash = 0;    Floor = 0;    A = $true;  Why = 'rule 15: under 1,200 MB for 15 s logs and never stops' },
    @{ Want = 'spare'; Warn = 14.9; Thrash = 0;   Floor = 0;    A = $true;  Why = 'CONTROL rule 15: 14.9 s under 1,200 MB says nothing yet' },
    @{ Want = 'warn'; Warn = 600;  Thrash = 0;    Floor = 0;    A = $true;  Why = 'CONTROL rule 15: ten minutes near 1,190 MB (this morning''s log) is a log line, not a stop' },
    @{ Want = 'warn'; Warn = 90;   Thrash = 90;   Floor = 90;   A = $false; Why = 'CONTROL rule 15: PHX_DEV_PRESSURE_STOP=0 never stops, and still logs' }
  )
  foreach ($v in $p15) {
    $p15n++
    $got = Get-DevServerVerdict -Rule 'pressure' -WarnSec $v.Warn -ThrashSec $v.Thrash -FloorSec $v.Floor -PressureArmed $v.A
    $ok = ($got -eq $v.Want)
    if (-not $ok) { $fails++ }
    Write-Host ("{0}  verdict={1} want={2}  {3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $got, $v.Want, $v.Why)
  }
  # The clocks, driven poll by poll on a fake 3-second timeline. Answers the second the first 'stop'
  # lands, or -1 for never. This is what proves "held for 30 s": one calm sample must restart the window.
  $mk = { param([int]$From, [int]$To, [int]$Avail, [double]$Reads) for ($t = $From; $t -le $To; $t += 3) { @{ T = $t; Avail = $Avail; Reads = $Reads } } }
  $firstStop = {
    param([object[]]$Samples)
    $st = @{}
    $t0 = [datetime]'2026-10-29T00:00:00'
    foreach ($s in $Samples) {
      $h = Update-DevPressureClocks -State $st -AvailMB $s.Avail -PageReads $s.Reads -Now $t0.AddSeconds($s.T)
      if ((Get-DevServerVerdict -Rule 'pressure' -WarnSec $h.WarnSec -ThrashSec $h.ThrashSec -FloorSec $h.FloorSec -PressureArmed $true) -eq 'stop') { return $s.T }
    }
    return -1
  }
  $timelines = @(
    @{ Want = 30; Why = 'rule 15: 450 MB and 1,500 reads/s from the first poll stops at 30 s';            S = @(& $mk 0 90 450 1500) },
    @{ Want = 45; Why = 'rule 15: 900 MB for 12 s, then 450 MB paging - the clock starts at 15 s, stops at 45 s'; S = (@(& $mk 0 12 900 2000) + @(& $mk 15 90 450 2000)) },
    @{ Want = 15; Why = 'rule 15: 250 MB with no paging at all stops at 15 s (the floor)';                S = @(& $mk 0 90 250 0) },
    @{ Want = -1; Why = 'CONTROL rule 15: 450 MB but only 900 reads/s for two minutes - never stops';      S = @(& $mk 0 120 450 900) },
    @{ Want = -1; Why = 'CONTROL rule 15: 5,000 reads/s at 600 MB for two minutes - never stops';          S = @(& $mk 0 120 600 5000) },
    @{ Want = -1; Why = 'CONTROL rule 15: exactly 300 MB is not UNDER 300 - never stops';                  S = @(& $mk 0 120 300 0) },
    @{ Want = -1; Why = 'CONTROL rule 15: 27 s paging, one calm poll, 27 s more - the window restarted';    S = (@(& $mk 0 27 450 1500) + @(& $mk 30 30 450 200) + @(& $mk 33 60 450 1500)) }
  )
  foreach ($tl in $timelines) {
    $p15n++
    $got = & $firstStop $tl.S
    $ok = ($got -eq $tl.Want)
    if (-not $ok) { $fails++ }
    Write-Host ("{0}  first stop at {1}s want={2}s  {3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $got, $tl.Want, $tl.Why)
  }
  # The page-read rate. Unreadable data must read as CALM, never as thrash.
  $s0 = [pscustomobject]@{ Reads = 1000000; Time = 100000000; Freq = 10000000 }
  $rates = @(
    @{ Want = 1000; Why = 'rule 15 rate: 3,000 page reads over 3 s is 1,000/s'; P = $s0;  C = [pscustomobject]@{ Reads = 1003000; Time = 130000000; Freq = 10000000 } },
    @{ Want = 0;    Why = 'CONTROL rule 15 rate: the first sample has nothing to compare with'; P = $null; C = $s0 },
    @{ Want = 0;    Why = 'CONTROL rule 15 rate: a wrapped counter reads as calm, not as thrash'; P = $s0;  C = [pscustomobject]@{ Reads = 5; Time = 130000000; Freq = 10000000 } },
    @{ Want = 0;    Why = 'CONTROL rule 15 rate: a clock that did not move reads as calm'; P = $s0;  C = [pscustomobject]@{ Reads = 1003000; Time = 100000000; Freq = 10000000 } }
  )
  foreach ($r in $rates) {
    $p15n++
    $got = [math]::Round((Get-DevPressurePageRate -Prev $r.P -Cur $r.C), 3)
    $ok = ($got -eq $r.Want)
    if (-not $ok) { $fails++ }
    Write-Host ("{0}  rate={1} want={2}  {3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $got, $r.Want, $r.Why)
  }
  # Which process it stops: the start-server.js child holding the memory, never the cheap parent.
  $parent = [pscustomobject]@{ Id = 101; GB = 0.07 }
  $child  = [pscustomobject]@{ Id = 102; GB = 3.4 }
  $other  = [pscustomobject]@{ Id = 103; GB = 2.8 }
  $picks = @(
    @{ Want = 102; Why = 'rule 15 target: the largest dev server process, one at a time'; S = @($parent, $other, $child) },
    @{ Want = -1;  Why = 'CONTROL rule 15 target: only the 0.07 GB parent alive - nothing worth stopping'; S = @($parent) },
    @{ Want = -1;  Why = 'CONTROL rule 15 target: no dev server alive - nothing to stop'; S = @() }
  )
  foreach ($pk in $picks) {
    $p15n++
    $vic = Select-DevPressureVictim -Servers $pk.S
    $got = if ($vic) { $vic.Id } else { -1 }
    $ok = ($got -eq $pk.Want)
    if (-not $ok) { $fails++ }
    Write-Host ("{0}  target={1} want={2}  {3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $got, $pk.Want, $pk.Why)
  }
  # And, as for rules 1 and 3, the loop calls it WITHOUT the flag, so the shipped default must be armed.
  $p15n++
  $liveP = Get-DevServerVerdict -Rule 'pressure' -WarnSec 30 -ThrashSec 30
  if ($liveP -ne 'stop') { $fails++ }
  Write-Host ("{0}  the LIVE config arms rule 15: 30 s of paging under 500 MB with the default flag gets verdict={1}, want=stop" -f $(if ($liveP -eq 'stop') { 'PASS' } else { 'FAIL' }), $liveP)
  Write-Host ("SELFTEST dev-exemption: {0} cases, {1} failed" -f ($cases.Count + 3 + $verdicts.Count + 1 + $p15n), $fails)
  exit $(if ($fails) { 1 } else { 0 })
}

# ---- rule 0 exemption live check (added 2026-09-12) --------------------------
# Rule 0's exclusion is the one that cannot be shown by a kill log, because rule 0 never kills and
# never logs a per-process line. This runs its REAL candidate filter against the real process table
# and prints, for every node.exe over the size bar, whether the trim would reach it. It trims
# nothing: it stops at the list.
#
# THIS OUTPUT IS NOT END-TO-END PROOF, and the SPARED log line is not either - both read the same
# set this builds, one step BEFORE the candidate filter that consumes it. Measured 2026-09-12: with
# the filter deliberately broken, the log still printed "rule 0 left it alone" while the trim emptied
# that very process. The only thing that settles it is the process's WORKING SET across a real pass.
if ($env:PHX_TRIM_EXEMPT_LIVETEST) {
  $devSkip = Get-ExemptDevServerPids
  $all = @(Get-Process -Name node -ErrorAction SilentlyContinue)
  Write-Output ("LIVETEST rule0  minPrivateMB={0}  node processes={1}" -f $TrimMinPrivateMB, $all.Count)
  foreach ($np in ($all | Sort-Object PrivateMemorySize64 -Descending)) {
    $mb = [math]::Round($np.PrivateMemorySize64 / 1MB)
    $overBar = ($mb -ge $TrimMinPrivateMB)
    $exempt = $devSkip.ContainsKey($np.Id)
    $verdict = if ($exempt) { 'EXEMPT  ' } elseif ($overBar) { 'trimmable' } else { 'under bar' }
    $cl = Get-CommandLineFor -ProcId $np.Id
    Write-Output ("  {0}  pid={1,-6} private={2,5}MB  ws={3,5}MB  | {4}" -f $verdict, $np.Id, $mb, [math]::Round($np.WorkingSet64 / 1MB), $cl.Substring(0, [Math]::Min(88, $cl.Length)))
  }
  Write-Output ("LIVETEST rule0: {0} exempt, {1} still trimmable" -f $devSkip.Count, @($all | Where-Object { ($_.PrivateMemorySize64 / 1MB) -ge $TrimMinPrivateMB -and -not $devSkip.ContainsKey($_.Id) }).Count)
  exit 0
}

# ---- dev-exemption live discovery check (added 2026-09-12) --------------------
# The self-test proves the DECISION; this proves the DISCOVERY, which is where a never-kill rule can
# plausibly be wrong - it reads the real process table and says, for every live node.exe, whether the
# watchdog would now spare it. Terminates nothing; exits.
if ($env:PHX_DEV_EXEMPT_LIVETEST) {
  $rows = @()
  foreach ($np in (Get-Process -Name node -ErrorAction SilentlyContinue)) {
    $cl = Get-FullCommandLineFor -ProcId $np.Id
    $rows += [pscustomobject]@{
      Pid    = $np.Id
      GB     = [math]::Round($np.PM / 1GB, 2)
      Spared = (Test-DevServerExempt -ProcId $np.Id -CommandLine $cl)
      Cmd    = $(if ($cl) { $cl.Substring(0, [Math]::Min(96, $cl.Length)) } else { '(unavailable)' })
    }
  }
  if (-not $rows.Count) { Write-Host 'LIVETEST dev-exemption: no node.exe is running - start a dev server and re-run' }
  foreach ($r in ($rows | Sort-Object GB -Descending)) {
    Write-Host ("{0}  pid={1,-6} {2,6:N2}GB  {3}" -f $(if ($r.Spared) { 'SPARED ' } else { 'killable' }), $r.Pid, $r.GB, $r.Cmd)
  }
  Write-Host ("LIVETEST dev-exemption: {0} node.exe alive, {1} spared, {2} still killable" -f $rows.Count, @($rows | Where-Object { $_.Spared }).Count, @($rows | Where-Object { -not $_.Spared }).Count)
  exit 0
}

# ---- single-instance guard --------------------------------------------------
# Two watchdogs running at once is exactly the double-launch shape that crashes the
# attendance agent, and it double-logs every kill (two "total kills this run: 1" lines
# for ONE dead process, 2026-08-26). Exit quietly if one is already up.
#
# The filter MUST exclude $PID and match on "-File": a CommandLine LIKE '*mem-watchdog.ps1*'
# also matches any QUERY about this script, because the path sits inside the command being
# run. That false positive reported "already running" twice against the query itself.
#
# REPLACED 2026-09-01 with a named mutex. The command-line scan above could not be made safe:
# it matches ANY process whose command line mentions this script, and the comment's own fix
# ($PID exclusion) does not help, because the OTHER process is the innocent one. On 2026-09-01
# a shell that merely LAUNCHED the watchdog carried the path in its own arguments, so every
# newly started watchdog saw that launcher, declared "another watchdog already running", and
# exited - three times in a row, leaving the machine with NO watchdog at all while the log
# cheerfully reported the opposite. A guard whose failure mode is silently disarming the thing
# it guards is worse than no guard. A named mutex asks the OS the real question - "does an
# instance hold this token" - and cannot be confused by anything written on a command line.
$script:InstanceMutex = $null
try {
  $created = $false
  $script:InstanceMutex = New-Object System.Threading.Mutex($true, 'Global\PhoenixWorkforceMemWatchdog', [ref]$created)
  if (-not $created) {
    # Someone else holds it. Confirm they are alive rather than assuming: an abandoned mutex
    # from a hard-killed instance is released by the OS, so WaitOne(0) succeeds and we adopt it.
    if (-not $script:InstanceMutex.WaitOne(0)) {
      # The keepalive task probes every 5 minutes, so THIS PATH IS THE HEALTHY OUTCOME about
      # 288 times a day - it means the real watchdog is up. Logging each one is the same
      # eviction problem as the PRESSURE spam below: routine success crowding out evidence.
      # Write it only when it is news, i.e. when the previous line was not already this.
      $lastLine = ''
      try { if (Test-Path $LogPath) { $lastLine = [string](Get-Content $LogPath -Tail 1 -ErrorAction SilentlyContinue) } } catch {}
      if ($lastLine -notmatch 'EXIT - another watchdog instance') {
        Write-Log "EXIT - another watchdog instance holds the mutex; this instance stops. (identical probes from the keepalive are not logged again until something else happens)"
      }
      exit 0
    }
  }
} catch {
  Write-Log ("mutex guard unavailable ({0}) - continuing without it" -f $_.Exception.Message)
}

Write-Log ("WATCHDOG START  killGB=$KillGB  globalWarnPct=$GlobalWarnPct  poll=${PollSeconds}s  critRamMB=$CritRamMB  batchMinGB=$BatchMinGB  deprioMinGB=$DeprioMinGB  memPrioApi=$($script:PrioAvailable)  idleClose=ChatGPT:$($IdleApps[0].LimitMin)min,Outlook:$($IdleApps[1].LimitMin)min-below-$($IdleApps[1].BelowMB)MB  oneDrive=quit-below-${OdQuitBelowMB}MB,restart-above-${OdRestartAboveMB}MB,on=$OdEnabled  whatsAppWeb=close-below-${WaCloseBelowMB}MB,idle-${WaIdleMin}min,on=$WaEnabled,winApi=$($script:WinApiAvailable)  devPressure=warn-below-${DevPressureWarnMB}MB-${DevPressureWarnSec}s,stop-below-${DevPressureStopMB}MB-and-over-${DevPressurePagesPerSec}reads-${DevPressureStopSec}s,floor-below-${DevPressureFloorMB}MB-${DevPressureFloorSec}s,on=$DevServerPressureArmed  pid=$PID")

# ---- rule 6 setup: create the capped job (added 2026-09-09) -----------------
# AFTER the mutex guard on purpose: only the one live instance should own the job, and the job
# dies with its last handle, so a losing instance creating one would tear the limit down again
# on its way out.
#
# FAILS OPEN, LOUDLY. If the helper is missing or the job cannot be created, every other rule
# still runs - a watchdog that refuses to start because one rule is unavailable is strictly worse
# than one running with four rules out of five. But it says so in the log rather than going quiet,
# because a ceiling that is silently absent is the failure mode nobody notices.
$script:PhxJobHandle = [IntPtr]::Zero
$script:jobAssigned = @{}
$script:jobAssignCount = 0
if ($JobCapEnabled) {
  try {
    . "$PSScriptRoot\phx-job-cap.ps1"
    $script:PhxJobHandle = New-PhxJobCap -PerProcessGB $JobCapPerProcessGB -JobGB $JobCapTotalGB
    Write-Log ("JOBCAP  armed - per-process {0}GB, all-node total {1}GB, kernel-enforced (rule 6)" -f $JobCapPerProcessGB, $JobCapTotalGB)
  } catch {
    $script:PhxJobHandle = [IntPtr]::Zero
    Write-Log ("JOBCAP  UNAVAILABLE - {0}. Every other rule still runs; the hard ceiling does not." -f $_.Exception.Message)
  }
} else {
  Write-Log "JOBCAP  disabled by PHX_JOBCAP_OFF"
}

$lastTrim = Get-Date
$killCount = 0
# state for rules 3 and 4 (added 2026-09-01)
$ramLowStreak = 0
$nextSeen = @{}
$lastNextScan = (Get-Date).AddSeconds(-$NextScanEverySec)
# state for rule 5 (added 2026-09-09). $null means "never fired", so the first pass under the
# floor is free to act rather than serving out a cooldown it never earned.
$script:lastMultiNextKill = $null
# state for rule 0 (added 2026-09-08). $lastTrim above is the LOG trimmer - unrelated.
$trimCpu = @{}
$lastTrimRun = (Get-Date).AddSeconds(-$TrimEverySec)
$lastPressureLog = (Get-Date).AddMinutes(-5)
$script:trimBackoffUntil = $null   # explicit: an unset var already reads $null, but the backoff
                                   # test is easier to trust when its start state is written down
# state for rule 15 (added 2026-10-29). Empty clocks, no previous page-read sample (the first rate reads
# as calm), and a warn line that is free to print the first time it is due.
$script:dpState = @{}
$script:dpPrev = $null
$script:dpLastWarn = (Get-Date).AddSeconds(-$DevPressureWarnEverySec)
$script:dpNoServerUntil = Get-Date
$dpKillMark = $null

while ($true) {
  try {
    $procs = Get-Process -ErrorAction SilentlyContinue

    # ---- rule 6: put every new node.exe under the kernel ceiling (added 2026-09-09) ----
    # ON THE 3-SECOND POLL, not the 60-second dev-server scan. A process must be inside the job
    # BEFORE it allocates, and the runaway this exists for reached 41 GB in forty seconds - a
    # 60s scan would meet it on the way down. The cost is one OpenProcess per process per
    # LIFETIME, not per poll: an already-assigned pid is skipped by the hashtable below.
    if ($script:PhxJobHandle -ne [IntPtr]::Zero) {
      foreach ($np in $procs) {
        if ($np.ProcessName -ne 'node') { continue }
        if ($np.Id -le 4) { continue }
        if ($script:jobAssigned.ContainsKey($np.Id)) { continue }
        # OWNER EXEMPTION 2026-09-12. A job-object limit is enforced by the KERNEL: the offending
        # VirtualAlloc fails and node aborts. That is a kill in every sense that matters to a dev
        # server, so an exempt server is never put INTO the job. Marked assigned anyway, so the lookup
        # costs one CIM query per pid per LIFETIME, not one per 3-second poll.
        # CONSEQUENCE, PLAINLY: a dev server is also outside the 11 GB TOTAL, so its memory no longer
        # counts toward the cap that catches several node jobs adding up. That is the half with teeth.
        if (Test-DevServerExempt -ProcId $np.Id) {
          $script:jobAssigned[$np.Id] = $true
          Write-DevExemptSkip -ProcId $np.Id -Rule 'rule 6 (kernel job cap)'
          continue
        }
        $script:jobAssigned[$np.Id] = $true      # mark first: a pid we cannot open must not be
                                                 # retried every 3 seconds for the life of the run
        try {
          if (Add-ProcessToPhxJob -Job $script:PhxJobHandle -ProcessId $np.Id) {
            $script:jobAssignCount++
            # Logged at a coarse cadence, not per process. A dev server spawns 3-4 node processes
            # and the suite spawns dozens; one line each would bury the KILL records this log
            # exists for, which is the same eviction problem the PRESSURE rate limit fixed.
            if ($script:jobAssignCount -le 3 -or ($script:jobAssignCount % 25) -eq 0) {
              Write-Log ("JOBCAP  {0} node processes now under the {1}GB/{2}GB ceiling (latest pid={3})" -f $script:jobAssignCount, $JobCapPerProcessGB, $JobCapTotalGB, $np.Id)
            }
          }
        } catch {}
      }
    }

    # ---- rule 10: CLAUDE FIRST (owner, 2026-09-12) ---------------------------------------------
    # BEFORE rule 0 on purpose: background apps are already LOW when a trim pass or Windows itself
    # goes looking for pages. Logged at most once per 10 minutes, and only when it changed something.
    if ($ClaudeFirstEnabled -and ((Get-Date) - $script:cfLastRun).TotalSeconds -ge $ClaudeFirstEverySec) {
      $script:cfLastRun = Get-Date
      try {
        $cf = Invoke-ClaudeFirst -Procs $procs
        if (($cf[0] + $cf[1] + $cf[2]) -gt 0 -and ((Get-Date) - $script:cfLastLog).TotalMinutes -ge 10) {
          $script:cfLastLog = Get-Date
          Write-Log ("CLAUDE-FIRST {0} Claude processes held at normal memory priority + no power throttling (raised {1}); {2} background app processes set LOW, {3} restored while in the foreground ('{4}') (rule 10, nothing killed)" -f $script:claudeFamily.Count, $cf[0], $cf[1], $cf[2], $script:cfForegroundName)
        }
      } catch { Write-Log ("rule 10 error: {0}" -f $_.Exception.Message) }
    }

    # ---- rules 11 + 12: close ChatGPT / Outlook when unused (owner, 2026-09-13) ---------------------
    foreach ($idleApp in $IdleApps) { try { [void](Invoke-IdleAppClose -App $idleApp -Procs $procs) } catch { Write-Log ("rule {0} error: {1}" -f $idleApp.Rule, $_.Exception.Message) } }

    # ---- rule 13: quit OneDrive while RAM is low, start it again when RAM recovers (owner, 2026-09-13) --
    if ($OdEnabled -and ((Get-Date) - $script:odLastRun).TotalSeconds -ge $OdEverySec) {
      $script:odLastRun = Get-Date
      try { [void](Invoke-OneDriveLowRam -Procs $procs) } catch { Write-Log ("rule 13 error: {0}" -f $_.Exception.Message) }
    }

    # ---- rule 14: close the WhatsApp Web app window while RAM is low (owner, 2026-09-13) --------------
    if ($WaEnabled) {
      try { Update-WhatsAppWebForeground -Procs $procs } catch { }
      if (((Get-Date) - $script:waLastRun).TotalSeconds -ge $WaEverySec) {
        $script:waLastRun = Get-Date
        try { [void](Invoke-WhatsAppWebLowRam -Procs $procs) } catch { Write-Log ("rule 14 error: {0}" -f $_.Exception.Message) }
      }
    }

    # ---- rule 0: NON-DESTRUCTIVE reclaim, tried BEFORE anything can be killed --------
    # Fires at $TrimWarnMB, which sits ABOVE rule 4's kill floor, so the free move always
    # comes first. See the config block for the log evidence this closes.
    if (((Get-Date) - $lastTrimRun).TotalSeconds -ge $TrimEverySec) {
      $lastTrimRun = Get-Date
      $availNow = Get-AvailableMB
      # A backoff is skipped outright when RAM is under the HARD floor: that is a real
      # emergency and a fault-back burst is cheaper than paging the desktop out.
      $backedOff = ($null -ne $script:trimBackoffUntil) -and
                   ((Get-Date) -lt $script:trimBackoffUntil) -and
                   ($availNow -ge $LowRamMB)
      if ($availNow -lt $TrimWarnMB -and -not $backedOff) {
        $r = Invoke-WorkingSetTrim
        $freedMB = [math]::Round($r[0])
        if ($r[1] -gt 0) {
          Write-Log ("TRIM  {0} idle processes, freed {1}MB working set; available {2}MB -> {3}MB (nothing killed; {4} Claude processes spared, rule 10)" -f $r[1], $freedMB, $availNow, (Get-AvailableMB), $script:trimClaudeSpared)
        }
        if ($freedMB -lt $TrimMinYieldMB) {
          $script:trimBackoffUntil = (Get-Date).AddSeconds($TrimBackoffSec)
          Write-Log ("TRIM  yield {0}MB below {1}MB - idle pages are already evicted; backing off {2}min (a drop below {3}MB still overrides)" -f $freedMB, $TrimMinYieldMB, [math]::Round($TrimBackoffSec/60), $LowRamMB)
        } else {
          $script:trimBackoffUntil = $null
        }
      }
      # drop CPU bookkeeping for processes that have gone away, so the table cannot grow
      # without bound across a multi-day run
      $liveIds = @{}
      foreach ($lp in $procs) { $liveIds[$lp.Id] = $true }
      foreach ($k in @($trimCpu.Keys)) { if (-not $liveIds.ContainsKey($k)) { $trimCpu.Remove($k) } }
      # Same bookkeeping for rule 6, and it matters more here: without it a multi-day run leaks a
      # hashtable entry per node process ever seen, and pid reuse would eventually let a NEW
      # process inherit a dead one's "already assigned" mark and never enter the job at all.
      foreach ($k in @($script:jobAssigned.Keys)) { if (-not $liveIds.ContainsKey($k)) { $script:jobAssigned.Remove($k) } }
    }

    # ---- rule 1: any single process over the hard per-process ceiling ----
    foreach ($p in $procs) {
      if ($p.Id -le 4) { continue }
      if ($Protected -contains $p.ProcessName) { continue }
      $gb = $p.PM / 1GB
      if ($gb -ge $KillGB) {
        $cmd = Get-CommandLineFor -ProcId $p.Id
        $reason = 'over-per-process-ceiling'
        # OWNER EXEMPTION 2026-09-12. Decided on the FULL command line, never on $cmd above, which is
        # truncated to 300 chars for logging - see Get-FullCommandLineFor.
        if ($p.ProcessName -eq 'node' -and (Test-DevServerExempt -ProcId $p.Id)) {
          # RE-ARMED 2026-09-21 (owner, "Over 8 GB or unused 25 min"): a dev server at or over the
          # ceiling is a runaway and is stopped. PHX_DEV_RUNAWAY_STOP=0 restores the skip.
          if ((Get-DevServerVerdict -Rule 'ceiling' -GB $gb) -ne 'stop') {
            Write-DevExemptSkip -ProcId $p.Id -Rule 'rule 1 (per-process ceiling)'
            continue
          }
          $reason = 'runaway-dev-server-over-ceiling (owner 2026-09-21)'
        }
        Write-Log ("KILL  pid={0} name={1} commit={2:N2}GB  reason={3}" -f $p.Id, $p.ProcessName, $gb, $reason)
        Write-Log ("      cmd: {0}" -f $cmd)
        try {
          Stop-Process -Id $p.Id -Force -ErrorAction Stop
          $killCount++
          Write-Log ("      killed OK (total kills this run: {0})" -f $killCount)
        } catch {
          Write-Log ("      KILL FAILED: {0}" -f $_.Exception.Message)
        }
      }
    }

    # ---- rule 2: global commit pressure -> take out the single largest offender ----
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    if ($os) {
      $limit = $os.TotalVirtualMemorySize * 1KB
      $free  = $os.FreeVirtualMemory * 1KB
      $usedPct = (($limit - $free) / $limit) * 100
      if ($usedPct -ge $GlobalWarnPct) {
        # OWNER EXEMPTION 2026-09-12: walk the sorted candidates and take the largest NON-dev-server,
        # rather than taking the largest and then refusing. Refusing would leave the rule with nothing
        # to do while a real runaway sat second in the list.
        $cand = $null
        foreach ($c in ($procs |
          Where-Object { $_.Id -gt 4 -and ($Protected -notcontains $_.ProcessName) -and ($_.PM/1GB) -ge $GlobalKillGB } |
          Sort-Object PM -Descending)) {
          if ($c.ProcessName -eq 'node' -and (Test-DevServerExempt -ProcId $c.Id)) {
            Write-DevExemptSkip -ProcId $c.Id -Rule 'rule 2 (global commit)'
            continue
          }
          $cand = $c
          break
        }
        if ($cand) {
          $cmd = Get-CommandLineFor -ProcId $cand.Id
          Write-Log ("KILL  pid={0} name={1} commit={2:N2}GB  reason=global-commit-{3:N1}pct" -f $cand.Id, $cand.ProcessName, ($cand.PM/1GB), $usedPct)
          Write-Log ("      cmd: {0}" -f $cmd)
          try { Stop-Process -Id $cand.Id -Force -ErrorAction Stop; $killCount++; Write-Log "      killed OK" }
          catch { Write-Log ("      KILL FAILED: {0}" -f $_.Exception.Message) }
        } else {
          Write-Log ("PRESSURE commit={0:N1}pct but no eligible target >= {1}GB (nothing killed)" -f $usedPct, $GlobalKillGB)
        }
      }
    }

    # ---- rule 3: reap ABANDONED dev servers (added 2026-09-01) --------------------
    # Size alone never caught these: on 2026-09-01 three wedged servers held 12 GB between
    # them and every one was UNDER the 6 GB ceiling. Idleness catches them. A dev server is
    # uniquely safe to reclaim - it holds no unsaved state, and a session that still wants
    # one simply starts it again.
    if (((Get-Date) - $lastNextScan).TotalSeconds -ge $NextScanEverySec) {
      $lastNextScan = Get-Date
      $live = @{}
      foreach ($ns in (Get-NextDevServers)) {
        $proc = Get-Process -Id $ns.ProcessId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        $live[$ns.ProcessId] = $true
        $gb = $proc.PM / 1GB
        $cpu = $proc.CPU
        if (-not $nextSeen.ContainsKey($ns.ProcessId)) {
          $nextSeen[$ns.ProcessId] = [PSCustomObject]@{ Cpu = $cpu; LastActive = (Get-Date) }
          continue
        }
        $entry = $nextSeen[$ns.ProcessId]
        if (($cpu - $entry.Cpu) -ge $NextIdleCpuSeconds) {
          $entry.Cpu = $cpu
          $entry.LastActive = Get-Date
        }
        $idleMin = ((Get-Date) - $entry.LastActive).TotalMinutes
        # OWNER EXEMPTION 2026-09-12. The bookkeeping above is deliberately left running, so rule 4's
        # quiet time and rule 5's LastActive are correct the moment the exemption is switched off.
        # RE-ARMED 2026-09-21 (owner, "Over 8 GB or unused 25 min"): an abandoned server is stopped
        # again. PHX_DEV_RUNAWAY_STOP=0 restores the skip.
        if ($DevServerKillExempt -and $idleMin -ge $NextIdleMinutes -and $gb -ge $NextIdleMinGB -and
            (Get-DevServerVerdict -Rule 'idle' -GB $gb -IdleMin $idleMin) -ne 'stop') {
          Write-DevExemptSkip -ProcId $ns.ProcessId -Rule 'rule 3 (abandoned idle dev server)'
          continue
        }
        if ($idleMin -ge $NextIdleMinutes -and $gb -ge $NextIdleMinGB) {
          Write-Log ("KILL  pid={0} name=node commit={1:N2}GB  reason=abandoned-dev-server-idle-{2:N0}min" -f $ns.ProcessId, $gb, $idleMin)
          try { Stop-Process -Id $ns.ProcessId -Force -ErrorAction Stop; $killCount++; Write-Log "      killed OK (reclaimed idle dev server)" }
          catch { Write-Log ("      KILL FAILED: {0}" -f $_.Exception.Message) }
          $nextSeen.Remove($ns.ProcessId)
        }
      }
      foreach ($k in @($nextSeen.Keys)) { if (-not $live.ContainsKey($k)) { $nextSeen.Remove($k) } }
    }

    # ---- rule 4: PHYSICAL RAM pressure (added 2026-09-01) -------------------------
    # See the config block for why this is not redundant with rule 2. Short version: commit
    # was 59% while RAM was 94.5%, so rule 2 could not fire, and the machine paged itself
    # into a crawl instead of freezing. This rule watches the number that was actually moving.
    #
    # DELIBERATELY CONSERVATIVE: it will only reclaim a dev server that has shown NO CPU for
    # two minutes. If every server on the box is genuinely working, it logs and does nothing -
    # interrupting real work to free memory is the owner's call, not the watchdog's. The 6 GB
    # ceiling in rule 1 still backstops a true runaway.
    try {
      $perf = Get-CimInstance Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop
      $availMB = [int]$perf.AvailableMBytes
      if ($availMB -lt $LowRamMB) { $ramLowStreak++ } else { $ramLowStreak = 0 }
      if ($ramLowStreak -ge $LowRamConsecutive) {
        $ramLowStreak = 0
        $target = $null
        # OWNER EXEMPTION 2026-09-12: like rule 5, this rule can only ever kill a dev server, so it now
        # has no move. It falls through to rule 5, which stands down too, and then to the PRESSURE line -
        # which still NAMES the biggest holders, so the log keeps saying what to close.
        if ($DevServerKillExempt) { Write-DevExemptSkip -ProcId 0 -Rule 'rule 4 (physical RAM pressure)' }
        foreach ($ns in (Get-NextDevServers)) {
          if ($DevServerKillExempt) { continue }
          $proc = Get-Process -Id $ns.ProcessId -ErrorAction SilentlyContinue
          if (-not $proc) { continue }
          if (($proc.PM / 1GB) -lt $LowRamKillGB) { continue }
          $entry = $nextSeen[$ns.ProcessId]
          $quietMin = if ($entry) { ((Get-Date) - $entry.LastActive).TotalMinutes } else { 0 }
          if ($quietMin -lt 2) { continue }
          if (-not $target -or $proc.PM -gt $target.PM) { $target = $proc }
        }
        if ($target) {
          Write-Log ("KILL  pid={0} name={1} commit={2:N2}GB  reason=physical-RAM-{3}MB-available" -f $target.Id, $target.ProcessName, ($target.PM/1GB), $availMB)
          try { Stop-Process -Id $target.Id -Force -ErrorAction Stop; $killCount++; Write-Log "      killed OK (RAM pressure)" }
          catch { Write-Log ("      KILL FAILED: {0}" -f $_.Exception.Message) }
        } else {
          # ---- rule 5 (added 2026-09-09): rule 4 found nothing IDLE to reclaim. Before
          # settling for a log line, check the one shape that froze this box twice that day -
          # SEVERAL dev servers, every one of them busy. See its config block above.
          $reclaimed = $false
          try { $reclaimed = Invoke-ConcurrentDevServerReclaim -AvailMB $availMB }
          catch { Write-Log ("rule 5 error: {0}" -f $_.Exception.Message) }
          if ($reclaimed) {
            # The MULTI line and its KILL records have just said everything the PRESSURE line
            # would have, and named names while doing it. Do not repeat it, and make the next
            # PRESSURE line wait its full minute so the kill stays readable in the log.
            $lastPressureLog = Get-Date
          } else {
            # RATE-LIMITED 2026-09-08. This fired every ~10s while under the floor, which fills
            # $MaxLogLines in about two hours and evicts the KILL records that are the only
            # reason to keep a log at all - 100+ identical lines on 2026-09-08 buried everything
            # before them. Once a minute now, and it NAMES the biggest holders, so the log says
            # what to close instead of only that something is wrong.
            if (((Get-Date) - $lastPressureLog).TotalSeconds -ge 60) {
              $lastPressureLog = Get-Date
              $who = try {
                (($procs | Where-Object { $_.Id -gt 4 } | Group-Object ProcessName |
                  ForEach-Object { [pscustomobject]@{ N = $_.Name; C = $_.Count; MB = [math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1MB) } } |
                  Sort-Object MB -Descending | Select-Object -First 3 |
                  ForEach-Object { "{0} x{1} {2}MB" -f $_.N, $_.C, $_.MB }) -join ', ')
              } catch { 'unavailable' }
              Write-Log ("PRESSURE physical RAM {0}MB available (floor {1}) - no idle dev server; rule 0 has already trimmed what it safely can. Top holders: {2}" -f $availMB, $LowRamMB, $who)
            }
          }
        }
      }
    } catch { }

    # ---- rule 8: CONCURRENT heavy batch jobs (added 2026-09-11) ---------------------------------
    # After rules 4 and 5, before rule 7, and it stands down for any poll in which an earlier rule already
    # killed something - the same kill-count mark rule 7 uses. The CIM scan behind it runs only once its
    # own streak holds, and the streak restarts after every attempt, so sustained pressure costs one scan
    # per $LowRamConsecutive polls, not one per poll.
    try {
      if ($null -eq $batchKillMark) { $batchKillMark = $killCount }
      $batchAvail = Get-AvailableMB
      if ($batchAvail -lt $LowRamMB -and $killCount -eq $batchKillMark) { $batchLowStreak++ } else { $batchLowStreak = 0 }
      if ($batchLowStreak -ge $LowRamConsecutive) {
        $batchLowStreak = 0
        try { [void](Invoke-ConcurrentBatchReclaim -AvailMB $batchAvail) }
        catch { Write-Log ("rule 8 error: {0}" -f $_.Exception.Message) }
      }
      $batchKillMark = $killCount
    } catch { }

    # ---- rule 9: DEPRIORITIZE heavy node jobs (added 2026-09-11) --------------------------------
    # Every poll, healthy RAM included. Touches a process once; the done-set is pruned as pids die.
    try { [void](Invoke-HeavyJobDeprioritize -Procs $procs) }
    catch { Write-Log ("rule 9 error: {0}" -f $_.Exception.Message) }

    # ---- rule 7: CRITICAL floor, ANY heavy node job (added 2026-09-11) --------------------------
    # After rules 4 and 5 on purpose, so they always get the first move. It also stands down for
    # any poll in which an earlier rule already killed something - two kills in one poll is guessing
    # - which it detects by comparing the kill count with the mark it left at the end of last poll.
    try {
      if ($null -eq $critKillMark) { $critKillMark = $killCount }
      $critAvail = Get-AvailableMB
      if ($critAvail -lt $CritRamMB -and $killCount -eq $critKillMark) { $critLowStreak++ } else { $critLowStreak = 0 }
      if ($critLowStreak -ge $CritRamConsecutive) {
        $critResult = 'none'
        try { $critResult = Invoke-CriticalRamReclaim -AvailMB $critAvail -Procs $procs }
        catch { Write-Log ("rule 7 error: {0}" -f $_.Exception.Message) }
        if ($critResult -eq 'killed') {
          $critLowStreak = 0
        } elseif ($critResult -eq 'none' -and ((Get-Date) - $lastCritLog).TotalSeconds -ge 60) {
          $lastCritLog = Get-Date
          Write-Log ("CRITICAL physical RAM {0}MB available (floor {1}) - no node job of {2}GB or more to reclaim; sessions, browsers and editors are never killed. Top holders: {3}" -f $critAvail, $CritRamMB, $CritKillMinGB, (Get-TopHolderSummary -Procs $procs))
        }
      }
      $critKillMark = $killCount
    } catch { }

    # ---- rule 15: a DEV SERVER that is freezing the machine (owner, 2026-10-29) ------------------------
    # LAST in the poll on purpose: rules 4, 5, 7 and 8 move first, so a typecheck or a test run is reclaimed
    # before the dev server is. A kill by any of them restarts every clock here - that kill changed the
    # picture, and two kills in one poll is guessing (the same mark rule 7 keeps). Stops dev servers ONLY:
    # its one candidate list comes from Get-NextDevServers.
    try {
      if ($null -eq $dpKillMark) { $dpKillMark = $killCount }
      $dpPerf = Get-CimInstance Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop
      $dpCur = [pscustomobject]@{ Reads = [double]$dpPerf.PageReadsPersec; Time = [double]$dpPerf.Timestamp_PerfTime; Freq = [double]$dpPerf.Frequency_PerfTime }
      $dpRate = Get-DevPressurePageRate -Prev $script:dpPrev -Cur $dpCur
      $script:dpPrev = $dpCur
      $dpAvail = [int]$dpPerf.AvailableMBytes
      if ($killCount -ne $dpKillMark) { $script:dpState = @{} }
      $dpHeld = Update-DevPressureClocks -State $script:dpState -AvailMB $dpAvail -PageReads $dpRate -Now (Get-Date)
      $dpVerdict = Get-DevServerVerdict -Rule 'pressure' -WarnSec $dpHeld.WarnSec -ThrashSec $dpHeld.ThrashSec -FloorSec $dpHeld.FloorSec
      $dpWarnDue = ((Get-Date) - $script:dpLastWarn).TotalSeconds -ge $DevPressureWarnEverySec
      # The command-line scan is the expensive part: it runs only when a stop or a warn line is due, and
      # not again for 30 s after it found no dev server, so a machine starved by something else is not
      # handed a CIM query every 3 seconds.
      if ((Get-Date) -ge $script:dpNoServerUntil -and ($dpVerdict -eq 'stop' -or ($dpVerdict -eq 'warn' -and $dpWarnDue))) {
        $dpServers = @()
        foreach ($ns in (Get-NextDevServers)) {
          $proc = Get-Process -Id $ns.ProcessId -ErrorAction SilentlyContinue
          if (-not $proc -or $proc.Id -le 4) { continue }
          $dpServers += [pscustomobject]@{ Id = $proc.Id; GB = ($proc.PM / 1GB) }
        }
        $dpVictim = Select-DevPressureVictim -Servers $dpServers
        if (-not $dpVictim) {
          $script:dpNoServerUntil = (Get-Date).AddSeconds(30)
        } elseif ($dpVerdict -eq 'stop') {
          $dpWhy = if ($dpHeld.FloorSec -ge $DevPressureFloorSec) { "under-{0}MB-for-{1:N0}s" -f $DevPressureFloorMB, $dpHeld.FloorSec } else { "under-{0}MB-and-{1:N0}-page-reads-per-s-for-{2:N0}s" -f $DevPressureStopMB, $dpRate, $dpHeld.ThrashSec }
          Write-Log ("KILL  pid={0} name=node commit={1:N2}GB  reason=dev-server-freezing-the-machine-{2}MB-available-{3} (rule 15, owner 2026-10-29)" -f $dpVictim.Id, $dpVictim.GB, $dpAvail, $dpWhy)
          Write-Log ("      cmd: {0}" -f (Get-CommandLineFor -ProcId $dpVictim.Id))
          try {
            Stop-Process -Id $dpVictim.Id -Force -ErrorAction Stop
            $killCount++
            Write-Log ("      stopped OK - the dev server only; Claude, the browsers and every other app untouched. Start it again with pnpm run dev:lean once RAM allows (PHX_DEV_PRESSURE_STOP=0 disarms rule 15; total kills this run: {0})" -f $killCount)
          } catch {
            Write-Log ("      KILL FAILED: {0}" -f $_.Exception.Message)
          }
          $script:dpState = @{}
        } else {
          $script:dpLastWarn = Get-Date
          $dpArmedNote = if ($DevServerPressureArmed) { "stopped at under $DevPressureStopMB MB with over $DevPressurePagesPerSec page reads/s for $DevPressureStopSec s, or under $DevPressureFloorMB MB for $DevPressureFloorSec s" } else { 'the stop is DISARMED (PHX_DEV_PRESSURE_STOP=0)' }
          Write-Log ("DEV-PRESSURE available {0}MB, under {1}MB for {2:N0}s, {3:N0} page reads/s - dev server pid={4} holds {5:N2}GB. Logged only; it is {6} (rule 15, owner 2026-10-29)" -f $dpAvail, $DevPressureWarnMB, $dpHeld.WarnSec, $dpRate, $dpVictim.Id, $dpVictim.GB, $dpArmedNote)
        }
      }
      $dpKillMark = $killCount
    } catch { Write-Log ("rule 15 error: {0}" -f $_.Exception.Message) }

    if (((Get-Date) - $lastTrim).TotalMinutes -ge 30) { Trim-Log; $lastTrim = Get-Date }
  } catch {
    Write-Log ("LOOP ERROR: {0}" -f $_.Exception.Message)
  }

  # Same hygiene as the trim pass, on the 3s poll: release this iteration's Process objects.
  # No forced collect here - at 20 iterations a minute that would cost more than it saves.
  if ($procs) { foreach ($dp in $procs) { try { $dp.Dispose() } catch {} }; $procs = $null }

  Start-Sleep -Seconds $PollSeconds
}
