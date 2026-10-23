---
name: the-slowness-sentinel-went-blind-for-eight-days
description: "The daily slowness sentinel wrote NOTHING from 16 to 23 Oct 2026 while Task Scheduler reported success every morning: 1dd182a0c (15 Oct 22:56, #5959) gave scripts/slow-audit.mjs a relative import of ./lib/refuse-arguments.mjs, and the sentinel copies that ONE file flat into Temp, so `await import` threw ERR_MODULE_NOT_FOUND, main() rejected before writing a line, and `conhost.exe --headless` reported ITS 0 to the scheduler. Fixed 23 Oct: scripts/lib is staged beside the copy, and any crash now writes its own FAIL line. A green scheduled task proves nothing when the action is wrapped in conhost."
metadata:
  node_type: memory
  type: project
  originSessionId: 06bdde62-ddb9-41da-86f7-38746027b3ab
  modified: 2026-10-23T10:29:18.050Z
---

Found 2026-10-23 while asking why 73 compactions cost 76.8 minutes. The compactions were the
symptom; this is why nobody knew.

**The silence.** `~/.claude/scripts/slowness-sentinel.log` held 7 entries, the last dated
**2026-10-15T07:45**. `Get-ScheduledTaskInfo 'Phoenix Slowness Sentinel - Daily'` reported
`LastRunTime 10/23/2026 06:15:01, LastTaskResult 0` - green every morning for 8 days while judging
nothing. `~/.claude/logs/slow-audit-alarms.json` had never been written at all.

**The cause, reproduced.** `1dd182a0c` (2026-10-15 22:56, #5959, "every script that parses arguments
refuses the flag it has never heard of") added to `scripts/slow-audit.mjs`:

    import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

The sentinel copies **only** that file out of `origin/main` into `os.tmpdir()/phx-slowness-sentinel`
and `await import`s it, so the relative specifier resolved to `<temp>/lib/refuse-arguments.mjs`,
which does not exist. Reproduced exactly by staging the same lone copy and importing it:
`ERR_MODULE_NOT_FOUND`. The last log entry is the morning OF the 15th; the commit landed that night;
the first silent day is the 16th. The timeline fits to the hour.

🔴 **Two guards were designed for this and both missed it.** `main()` had no try/catch, so the throw
rejected before any `writeEntry` - and the script's own header says "A crash (nothing written) exits
non-zero, which the watcher reports as 'did not finish'". But the task's action is
`conhost.exe --headless "node.exe" "...slowness-sentinel.mjs"`, so **Task Scheduler records
conhost's exit code, not node's** - `LastTaskResult 0`. The failure watcher
(`slowness-sentinel-watch.ps1`, 30 minutes later, also wrapped in conhost) reads the LOG, and a
crash writes no line, so there was nothing to read either. A design that reports a crash through an
exit code cannot survive a conhost wrapper.

**What the blindness cost.** The limits were already correct in `TRANSCRIPT_LIMITS`
(`compactDefaultNine` limit 0, `preToolUseMaxMs` 60,000, `userPromptSubmitP50Ms` 800). Run by hand
for 23 Oct, three were crossed: 15 summaries in the default nine-section layout, a PreToolUse
dispatcher run of 95,405 ms, and `task-rules-reminder` at p50 5,499 ms. Every one of those would
have reached the phone each morning. The sentinel's last real entries (11-14 Oct) show it had been
catching the summary-layout drift reliably before it broke.

**The fix (2026-10-23, `~/.claude/scripts/slowness-sentinel.mjs`).**
- `scripts/lib/` is staged beside the copied `slow-audit.mjs` under
  `<temp>/phx-slowness-sentinel/<sha10>/scripts/`, so ANY relative import under `scripts/` resolves
  rather than only the one file needed today. 13 files, none importing a sibling.
- `await main()` is wrapped: a crash writes `FAIL window unknown PROBLEMS: ... so the day was not
  judged`. 🔴 **The words "was not judged" are load-bearing** - `windowFor` filters such a line out
  of the measured set, so the day is measured again next run instead of being skipped for ever.
- Backup: `~/.claude/backups/slowness-sentinel.mjs.pre-stage-fix-2026-10-23`.

**How to apply.** A scheduled task whose action is `conhost.exe --headless ...` reports CONHOST's
status, so **never read `LastTaskResult` as proof the job worked** - read the job's own log and check
its newest entry is recent. The same wrapper is on most Phoenix tasks. And a script that copies one
file out of a ref to run it in isolation breaks the day that file gains a relative import, silently:
stage its directory, not the file. Related: [[the-dispatcher-90s-timeouts-are-load-outliers-not-a-defect]],
[[a-manual-scheduled-task-run-leaves-no-trace]], [[slowness-audits-compare-before-and-after]].
