---
name: repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm
description: "`repo-doctor --fix` FAILS with EPERM on any `_wt-*` husk, because the husk is a node_modules tree of ~3,372 DANGLING pnpm junctions and Node's fs.rmSync cannot walk those on Windows. AGENTS.md prescribes --fix as THE husk remedy, so the tool has probably never cleared a real one — use `rmdir /s /q`."
metadata: 
  node_type: memory
  type: project
  originSessionId: e6867832-e139-4206-bc0f-eb6ccc99fc5a
  modified: 2026-08-23T12:29:17.231Z
---

`node scripts/repo-doctor.mjs --fix --force` reported **`FAILED ... EPERM`** on both `_wt-nursery-venue`
and `_wt-review-banner` (2026-08-23, owner ran it). Both husks survived. Each one holds exactly one child
— `node_modules` — containing **1,476 dirs and 3,372 reparse points (pnpm junctions), every one dangling**
because the pnpm store entries they point at are long gone.

**Node's `fs.rmSync(dir, { recursive: true, force: true })` cannot delete that shape on Windows.** It
walks into reparse points instead of unlinking them, and throws `EPERM` partway through. `force: true`
does not help — that flag suppresses *ENOENT*, not a permission fault on a junction. This is the exact
call at `scripts/repo-doctor.mjs:851`.

**So `--fix` has probably never successfully cleared a `_wt-*` husk on this machine.** It only ever
removes trivially-empty leftovers. That very likely explains the historical accumulation AGENTS.md §5
records — *"26 folders was the historical failure mode"* — while the documented remedy appeared to exist
and appeared to run. See [[a-wired-healthchecks-slug-does-not-mean-anything-calls-the-route]] for the same
shape: a wired remedy that nothing ever actually completes.

**What removes them:** `rmdir /s /q` unlinks a junction instead of descending into it.

```
cmd /c rmdir /s /q "F:\Phoenix Workforce\_wt-nursery-venue"
```

**Why:** the husk payload is entirely pnpm's junction farm. AGENTS.md §5 and `repo:doctor`'s own output
both prescribe `--fix` as the fix, so a session reads "run --fix" and reports the husks cleared without
ever confirming — and `repo:doctor` will still list them next run, which reads as *new* husks rather than
the same ones.

**How to apply:**
1. **Always re-check the folder on disk after any husk cleanup.** `[ -d "$p" ]`, or compare
   `CreationTime` — a deleted-and-recreated directory gets a *fresh* creation stamp, so an OLD stamp
   proves it was never deleted. On 2026-08-23 two husks were reported removed and the 08-21 creation
   times proved otherwise.
2. **Never filter `--fix` output without including `FAILED`.** A filter of
   `"REMOVED|SKIPPED|aborted|husk"` hides the failure branch completely, leaving only
   `Removed 0 husk(s).` — which is indistinguishable from a run that never tried. That mistake cost two
   round trips here. Run it unfiltered; it is only a few lines.
3. `--force` skips **only** the concurrent-session count (`repo-doctor.mjs:787`). The per-husk
   re-verification at :843 stays armed and still SKIPs anything that gained a file, so `--force` is not
   the dangerous part — but it is also not what makes the delete succeed.
4. The session guard fires at **>1** `claude-code` process and this machine routinely runs ~10, so plain
   `--fix` aborts by default. The abort line prints **last**, after the MEMORY INDEX block — easy to
   scroll past and misread as success.
5. Before deleting any husk, run the AGENTS.md §5 rescue scan for `.xlsx`/`.pdf` regardless of what
   `repo:doctor` claims. All four here held **0 files, 0 documents** — verify, do not assume.

## CONFIRMED 2026-08-23 — `rmdir` clears the junction tree; the leftovers are a DIFFERENT cause

`_wt-nursery-venue` (1,476 dirs + 3,372 dangling junctions) **was removed by `rmdir /s /q`** after
`repo-doctor --fix --force` had failed on it with EPERM. Mechanism above is confirmed, and 9,696
reclaimable path entries went to **0**.

**Two husks did NOT go, for an unrelated reason — and it is not a bug.** Both were empty
`.claude/worktrees/<session-name>` stubs, and `rmdir` returned *"The process cannot access the file
because it is being used by another process."* A live Claude Code session still holds a handle on (or has
its working directory inside) a folder whose worktree was already removed — `git worktree remove` deleted
the contents, the process kept the now-empty directory alive. **Leave them.** `repo:doctor` scores them
at **0 dirs, 0 dangling links, 0 empty path entries reclaimable**, so they cost nothing at all; they
vanish when that session exits. Do not hunt them, and do not force-kill a session over a zero-cost stub.

**Diagnostic order that actually works, cheapest first:**
| Symptom from a delete attempt | Cause | Do |
| --- | --- | --- |
| `EPERM` from `fs.rmSync` (i.e. `repo-doctor --fix`) | pnpm junction farm | `rmdir /s /q` |
| *"being used by another process"* | live session holds the handle | leave it; it is 0-cost |
| *"The filename, directory name, or volume label syntax is incorrect"* (exit 123) | **your own quoting**, not the folder | see below |

**The Bash tool cannot pass a Windows path into `cmd`.** `cmd //c "rmdir /s /q \"$p\""` from the Bash
tool returns *"The filename, directory name, or volume label syntax is incorrect"*, exit **123**, and
deletes nothing — MSYS rewrites the path and the `//c` form compounds it. Sibling of
[[git-ref-colon-path-is-mangled-by-msys-returns-empty]]. **Use the PowerShell tool instead**, which takes
the path literally:

```
cmd.exe /c "rmdir /s /q `"$t`""      # inside a PowerShell foreach over -LiteralPath targets
```

This cost four failed round trips: the same mangling silently no-opped every hand-run command, and each
time the husk was still present it read as a lock. **When a delete "does nothing", check your quoting
before you blame a handle** — and always `Test-Path` immediately after, in the same script, so the
result is proven rather than reported.
