---
name: the-dispatcher-90s-timeouts-are-load-outliers-not-a-defect
description: "The PreToolUse dispatcher hitting its 90,000 ms ceiling is machine load, NOT a slow guard — C20's whole mirror comparison measures 1,675 ms and the dispatcher's p50 is 869 ms over 884 runs. All 17 timeouts of 30 Sep-23 Oct fell in ONE 90-minute window on 23 Oct. Never lower the ceiling to cap the wait: the dispatcher fails OPEN, so a lower ceiling silently disables bash-guard C8/C12/C19/C20 under exactly the load that produced the outlier."
metadata:
  node_type: memory
  type: project
---

Measured 2026-10-23 while answering "fix the PreToolUse dispatcher timeouts".

**What the transcripts show.** 17 timed-out hook runs across the 50 most recent sessions
(30 Sep - 23 Oct, 98,633 lines, 7 projects). Every one of them fell between **08:32 and 10:04 Cairo
on 23 Oct** - zero on the other 22 days. Nine were the PROJECT PreToolUse dispatcher at its
90,000 ms ceiling (91.9-95.4 s); eight were `task-rules-reminder.mjs` at its 5,000 ms ceiling.

**The false lead, and why it is false.** All nine dispatcher timeouts directly followed a `git add`
or `git push` whose commit touched `.claude/`, which is exactly bash-guard **C20**'s trigger - so it
reads as C20 walking 1,480 memory files. It is not. Timed in the primary checkout:

| C20 step | Measured |
| --- | --- |
| `git diff --name-only origin/main...HEAD` (the cheap gate) | 86 ms |
| read the live memory dir, 1,480 `.md` files, sync | 882 ms |
| `readMirrorFromRef(HEAD)` - 1,467 files, `ls-tree` + `cat-file --batch` | 697 ms |
| `cloudMirrorDrift(live, mirror)` - pure compare | 10 ms |
| **total real work on a `.claude` push** | **1,675 ms** |

`readMirrorFromRef` already uses exactly TWO git processes, not one per file, so there is no
per-file spawn to remove. `scripts/slow-audit.mjs --transcripts --since 2026-10-23` puts the
dispatcher at **p50 869 ms, p90 5,540 ms, max 95,405 ms over 884 runs** - the ceiling runs are ~1%
outliers, 50x the slowest real work inside, under 8-session load with 2.4 GB free RAM.

🔴 **Never lower the 90 s ceiling to cap the wait.** The dispatcher FAILS OPEN - a crash or timeout
is reported in `systemMessage` and never blocks - so a 30 s ceiling would not make the session
faster, it would make bash-guard's C8 (local typecheck), C12 (gitleaks), C19 (bare python) and C20
(cloud mirror) **silently stop refusing** under precisely the load that produced the outlier. Nine
90-second waits bought nine correctly enforced guard checks. `docs/hook-dispatcher.md` already
reached the same verdict on 2026-10-08 ("why nothing was changed", "what makes this call slow is the
machine, not this file"); this is the measurement that extends it to the ceiling runs.

**The one thing that WAS a misconfiguration:** `task-rules-reminder.mjs prompt` carried a 5-second
timeout in `~/.claude/settings.json` while its real work is reading a 3,224-byte text file, stdin,
and a small per-session counter - and all 8 of its recorded runs in the window hit that ceiling, so
the TASK RULES block never reached the model on those prompts. The fix is the budget, not the code.
See [[task-rules-reminder-every-tenth-prompt]] for why it only runs on every 10th prompt.

**The real time sink that day was not hooks at all:** 59 compactions, 0.8 hours frozen, median
context 367,696 tokens when one fired. Against that, the nine dispatcher outliers cost 13.5 minutes.

**How to apply:** start any "the hooks are slow" question at
`node scripts/slow-audit.mjs --transcripts --since <day>`, compare its p50 against the ceiling
before suspecting a guard, and time the suspected guard's own steps before changing anything.
Related: [[slowness-audits-compare-before-and-after]], [[worktree-payload-is-the-repo-slowness]],
[[desktop-slowness-2026-10-08-is-compaction-and-the-window-process]].
