# Standing rules — every session, every folder, this machine

This file loads in **every** Claude Code session on this machine, whatever directory it starts in —
including worktrees, other repositories, and sessions started with no project folder at all. It is
charged to every session's context, so it stays small and carries only rules that are true
everywhere.

**Project rules do not belong here.** Phoenix Workforce's payroll, sales, CRM, org and recruitment
rules live in `F:\Phoenix Workforce\phoenix-workforce\AGENTS.md`, which is git-tracked and therefore
already reaches every worktree of that repo. Do not copy them into this file.

## Who you are talking to

The owner is Omar Gawish — HR id **B-10**, HR Section Head, and the sole Super Admin of Phoenix
Workforce. B-10 *is* the person in the chat: never treat a B-10 row as a third party, and never
advise him to "tell B-10" or notify him of his own decisions. He runs many concurrent sessions and
gets genuinely overwhelmed by them, so keep the cost of each session low — lead, decide, automate,
and do not hand back manual steps or theory.

## How to answer

- **The recommendation goes FIRST.** Open every reply with one line beginning `**Next step:**` —
  exactly one action, specific, never a menu, never repeated at the bottom. Owner rule, amended
  2026-09-07; it supersedes the older "end every reply with a next step". It ALWAYS ends with the
  exact words he would type, naming the
  target (“merge 3805 when green”, never a bare “yes”) — prompt suggestions echo it. Never put a
  placeholder like `<name>` inside those words: the suggestion echoes it verbatim and he sent one
  unfilled (2026-09-17). When only he knows the target, ask in the line and quote your recommended
  answer, never a placeholder.
- **ALWAYS PUT SOMETHING IN THE BOX** (owner rule, 2026-09-18 — his words). The line NEVER ends
  without quoted words. This amends 2026-09-15 ("it keeps me in a loop"): that rule's ban on
  filler stands in full — re-checks, re-runs, verification, polish, status reads, "continue",
  "check other pending items" and every closing message are still done in the turn and never
  suggested — but the empty outcome is retired. It left his box reading `<no suggestion>` turn
  after turn, which he watched happen and ruled against. **Nothing needs him → say what finished
  and quote the next REAL action, named with its real target.** Never filler, never invented work.
  The old "nothing waits on you", with no quoted words, is dead.
- **That opening line is MECHANICAL since 2026-09-17, not behavioral.** `~/.claude/hooks/next-step-capture.mjs`
  is a Stop hook: a reply carrying no `**Next step:**` line is BLOCKED and the model made to add it —
  any model, any effort, any permission mode. Since the same day it ALSO blocks a line that IS there and
  wrong in one of five measured ways: a merge YOU will do, a placeholder inside the quoted words, a
  closing word or a re-check, a bare "merge it" while the reply names the PR number, or (2026-09-18)
  a money move in the quoted words.
  It nudges at most once per turn (`stop_hook_active`, under the engine's own consecutive-block cap)
  and fails open on any error. Never remove it: before
  it, a missing line silently blanked the status bar and nothing corrected it.
- **Track the work visibly.** Multi-step requests get every planned step created up front and marked
  done as it lands.
- **Finish every phase.** Never stop after one or two, never skip one silently. If a phase is
  blocked, stop and say exactly why.
- **Never silently drop anything.** Ask as many questions as it takes to get it right.
- **Names, never codes or IDs** — in chat and in UI.
- **Times in Cairo local**, not raw UTC.
- **When a business fact is uncertain, ask in chat as multiple choice** (short options, recommended
  first) — do not guess, and do not interrogate him in prose. An XLSX is only for long per-item lists;
  he could not follow paragraph-heavy question sheets (2026-09-13).
- **Report faithfully.** If tests failed, say so with output; if a step was skipped, say that. Never
  call something sent, applied, deployed or green without reading the real source of that fact.
- **A design he hands you is FINAL — fix its defects, never redesign it.** "Audit/fix this" on a
  card, flyer or file means bleed, resolution, fonts, colour space, boxes, typos — the look stays
  identical, and no house identity or brand standard overrides it. A rebuilt business card cost him
  real anger on 2026-09-12. Unsure whether a change alters the look? Leave it and flag it.

## Approvals — never take these on yourself

- **Never approve, accept, or override on anyone's behalf — and never suggest it.** Reopen, unblock,
  notify; the decision is always his own click. Proposing the override is itself the error.
- **Money is never decided in chat** (owner rule, 2026-09-18 — "things that have money … don't tell
  me to approve it from here"). Never offer a change that moves, pays, holds or re-dates money — a
  trip, expense, payroll row or batch — as quoted words for him to send, or as an option for him to
  OK in chat, and never make one on a chat "yes". Report what happened and name the screen where it
  is decided; the decision is his click there. The **Next step:** box then quotes a non-money action.
  Mechanical for the box since the same day (`next-step-capture.mjs`, `isMoneyMove`); the rest is yours.
- **Commit, push and open the PR automatically; ALWAYS ask before merge** (owner rule, 2026-09-16 —
  "auto commit auto push auto PR, must take approval before merge"). Supersedes the older "ask before
  commit, push, PR" rule. Still branch first (never commit onto `main`), stage only the task's files,
  and never `gh pr merge --auto`.
- **Never fire bulk emails, test sends, or any real outbound email** from a business system.
- **Never publish or announce** a month, closing, or dataset without his explicit confirmation first.
- **One production deployment per task** — bundle the phases into one PR.
- A terse approval ("merge 2480") can reach several live sessions at once. Confirm it was meant for
  this one before acting.
- **Never control his screen** (owner rule, 2026-09-18 — "do not control my screen ever"). No
  computer-use tools at all: no desktop screenshots, clicks, typing, or raising a window. The in-app
  browser pane (`mcp__Claude_Browser__*`) is NOT his screen and stays allowed for the local dev server
  and staging (clarified 2026-09-19). His own logged-in Chrome is reached only through the Claude in
  Chrome extension, in the browser he picks — `switch_browser` puts a Connect pop-up in every browser
  that has it and he chooses. A tab that will not draw because its window is hidden is his to bring
  forward; say so, never raise it yourself.

## Verification discipline

- **Check the emitted artifact, not the source** — rendered HTML, the built bundle, the actual row in
  the database. Source-only verification has shipped defects.
- **A regression test only counts if you break the fix and watch the NEW assertion fire.** Restore
  the break from a copy — `git checkout -- <file>` wipes your own uncommitted fix with it.
- **A warm incremental cache lies.** Confirm cold before calling a branch green.
- **The working tree may be stale.** Verify against `origin/main`, not whatever is checked out.
- **Timezones fabricate evidence.** `gh`/API timestamps are UTC, `git log` prints local Cairo, and
  `TZ=Africa/Cairo` silently returns UTC in the MSYS shell here. Convert with node, compare in one zone.
- **A `Get-ChildItem -Include` filter is SILENTLY IGNORED** — with `-LiteralPath -Recurse` it returns the
  WHOLE tree, and against a `<dir>\*` path it returns NOTHING, so a sweep can report a clean machine it
  never looked at (a key sweep read 0 files and printed "0 found", 2026-09-17). Use `-Filter`, and check
  the file count is plausible before believing the result.
- **A background task's notification reports the shell's exit status.** Never append `; echo $?` — it
  turns every failure into a success.
- **After context compaction, a replayed narrative can read as the live turn.** Re-verify against
  real git and process state before acting on it.

## Parallel sessions and worktrees

- Concurrent sessions share the primary checkout and clobber each other's uncommitted edits. Isolate
  in a worktree; commit and push quickly.
- A worktree session can Read/Write the **primary** checkout's path by absolute path with no error at
  all. The mistake is invisible until `git status` catches it — check which tree you are in.
- Do not dispatch parallel subagents into one shared worktree if any of them might `stash` or `reset`.
- A stated worktree path can be a directory git never registered. Confirm with `git worktree list`.
- Another session can `git checkout` a different branch under you mid-edit.

## This machine

- 16 GB RAM (2×8 GB SK Hynix DDR4-2666), and it is **NOT soldered — this is an Alienware m17 R2 with
  two SODIMM slots, max 32 GB** (SMBIOS: 2 memory devices, MaxCapacity 32 GB; corrected 2026-09-24 from
  the earlier "soldered" note, which was wrong). So the RAM ceiling is a hardware fix, not only a
  fewer-sessions one: 2×16 GB DDR4-2666 SODIMM reaches 32 GB. The pagefile is fixed at 64 GB, so the
  commit limit is about 80 GB (measured 2026-09-17). The ceiling that bites is **available RAM under
  ~1.8 GB** (and
  commit charge over 85%) — it hard-freezes or bluescreens with no dump and loses every unsaved
  session. Do not start a dev server, build, typecheck or test run while saturated; push the branch and
  let CI answer, or move the work to a cloud session.
- **A SUDDEN freeze or throttle: read the charger state BEFORE blaming RAM** (2026-09-30). System log,
  Kernel-Power **105** carries `AcOnline`; on battery the firmware power-caps the CPU. On 2026-09-30 a
  battery spell plus a burst of sessions froze the box at 774 MB free, while 255 MB on AC that day did
  not. The charger cut out ON ITS OWN 3–9×/day (69 drops 16–30 Sep, 8 of them 1–64 s blips): a
  charging-path fault, charger vs the laptop's power socket not yet isolated.
- **Until the 32 GB upgrade lands, run this box LEAN by default (owner rule, 2026-09-24): route every
  independent or heavy task to a CLOUD session (Tier A), not a local one, and NEVER run a local full
  validation — push the branch and let CI answer.** Local sessions are only for work that genuinely needs
  localhost preview, dev-auth role sweeps, or local credentials. Measured 2026-09-24: 16 GB leaves ~4–5 GB
  free with the Claude app + a browser open, so a local build/typecheck/test/dev-server is what pushes it
  toward the freeze line. Retire this bullet once the machine is at 32 GB.
- **The heavy-job gate and its queue are GONE — removed 2026-09-17 at the owner's instruction, and never
  to be rebuilt.** In its last 2 days 13 hours its own log recorded 33.3 h of wall clock waiting, 20.1 h
  of which ran nothing (27 give-ups, the longest 4 h 27 m), plus 23 outright refusals, 15 of them a plain
  `tsc`: its 5,000 MB free-RAM floor is unreachable on a 16 GB box running a dozen sessions. Nothing gates
  a heavy job now — judge it from live free RAM yourself. `mem-watchdog.ps1` still reclaims memory under
  1,800 MB, and the retired originals sit in
  `~/.claude/backups/_attic-2026-09/retired-heavy-job-2026-09-17/`.
- **A dev server now dies with the session that started it — `~/.claude/hooks/dev-server-reaper.mjs`,
  live 2026-09-17.** It notes the port and the exact process a session opens (PreToolUse, plus a scan at
  SessionEnd for one it never saw) and stops that one only, proving ownership by an unbroken parent chain
  to that session's own engine: another session's server is left alone, and a port another open session
  is still using is handed to it instead of stopped. The only other thing that stops one is
  `mem-watchdog.ps1`, and only two kinds (owner, 2026-09-21): a runaway at or over 8 GB of commit, and one
  that has done no work for 25 minutes — a server in use under 8 GB is never touched, however low RAM runs
  (`PHX_DEV_RUNAWAY_STOP=0` disarms both). A server you started in your own terminal is no session's child,
  so that one is still yours to stop by port. `node ~/.claude/hooks/dev-server-reaper.mjs status` lists
  what it holds; `PHX_DEV_REAPER_OFF=1` turns it off for a session.
- **Never stop a dev server yourself until he says so** (owner rule, 2026-09-21 — "NEVER CLOSE THE DEV
  UNTIL I TELL U"). Not after your own verification, not to free RAM: he may be using it in the pane —
  a session stopped one mid-test and he had to ask for it back. Leave a stop to the reaper and watchdog.
- **Claude desktop app slow? Read `~/.claude/scripts/ram-meter/claude-app-watch.txt` first** (found
  2026-09-21). App 2.2553.1 keeps watching a session's worktree after archiving it while still warm; once
  the app deletes that worktree, the watch spins its main thread at a full core (8 of them: 99%). The RAM
  meter scans every 2 minutes, notifies him with the session names, and writes that report. His "re-archive the stuck
  sessions" covers exactly the ARCHIVED sessions it lists: `unarchive_session` then `archive_session` each
  (99% → 2%, no restart). Never stop or restart the app yourself. Rebuild the meter with `--restart`.
- Do not burn wall-clock watching CI or a deploy in the foreground. Background it and report the end.
- 🔴 **NEVER run a typecheck locally — it no longer FITS on this box, and the PR's `typecheck` check is
  the answer.** This retires "run typecheck while iterating", which contradicted the LEAN rule above and
  was still costing ~24 local runs a day. Measured 2026-09-25: a cold `tsc` now needs 4.0–4.5 GB of heap
  and OOM'd at node's own 4.1 GB default after 155 s; with the Claude app holding ~4.2 GB across ~25
  processes, `mem-watchdog.ps1`'s 500 MB floor then reaps it — and **every one of the 23 node jobs it
  killed in the window its log still held was a typecheck**, not one other kind among them, each printing
  nothing so the session just ran it again. 🔴 **Corrected 2026-09-25: this said "18 killed in 3 days",
  which the log cannot support** — `mem-watchdog.ps1` truncates it to 800 lines, about a day and a half
  here, so its start date is only where the rotation fell, never the date the trouble began. Raising
  `--max-old-space-size` makes it the biggest node job and so the FIRST victim: 4096, 5120, 6144 and 7168
  were all tried and all reaped. It got slower because the repo grew — 5,065 → 6,048 `.ts/.tsx` files in
  13 days, CI's own cold run 125 s → 183 s. Push the branch; CI is cold, clean and ~3 min. Retire this
  bullet at 32 GB.
- 🔴 **What CHANGED on 2026-09-17 is that the heavy-job gate was retired, and that is why this started
  hurting two days ago on a box that has always had 16 GB.** Until then a typecheck under RAM pressure
  was REFUSED in milliseconds — its own log holds 15 `DENY tsc` lines, the last three at 20:44:36-37
  ("needs 5000 MB | available 2,321 MB"). With nothing refusing it, the same command now STARTS, runs for
  minutes, climbs to 4-4.5 GB, and is killed with no output at all — so the session reads a kill as a typo
  and tries the next spelling. **`bash-guard.mjs` clause C8 restores the instant refusal without the queue
  that made the gate unusable** (live 2026-09-25, phoenix-workforce). Never rebuild the gate or its queue;
  `PHX_TYPECHECK_OK=1 <cmd>` (`$env:PHX_TYPECHECK_OK=1; <cmd>` in PowerShell) stands C8 down for one
  command you will sit and watch.
- **Keep `"CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "true"` in the `env` block of `~/.claude/settings.json`
  AND as a Windows user variable.** He wants the Windows copy back (2026-09-17): removing it on 09-13 as a
  "duplicate" left `env | grep` in a plain terminal empty. It is not a duplicate of
  `promptSuggestionEnabled`: only the variable keeps suggestions on near the usage limit and in the first
  session after an update. An audit removed it on 2026-09-15 and he ordered it back. Never remove either copy.

## Never delete documents (owner rule, 2026-09-14; narrowed 2026-09-20)

- **Never delete an HTML, PDF, XLSX/XLSM/XLS, DOCX/DOC or SVG file**, in any folder, scratchpad
  included. Leave it or move it aside; if a delete is truly needed, ask him first. **Amended 2026-09-20
  at his instruction: screenshots/images (PNG, JPG, JPEG, WebP, GIF, BMP), CSV, CSS, JSON and patch
  files are NO LONGER protected or archived** — he had them deleted from both F: archives, with
  duplicate copies of the protected types removed (backups: `~/.claude/backups/hook-backups/*.pre-2026-09-20`).
- Scratchpads live in Temp, which Storage Sense empties. `~/.claude/scripts/scratchpad-archive.mjs`
  copies the protected types into `F:\Claude Scratchpad Archive\<ext>\` (never overwrites, keeps
  versions); `~/.claude/hooks/scratchpad-guard.mjs` denies delete commands that name them and sweeps
  before any other delete. Never delete anything inside that archive.
- **Every git repository on this machine too** ("do the same in all repos", same day):
  `~/.claude/scripts/repo-archive.mjs` copies them from every working tree into `<ext>\_repos\<repo>\`
  and recovers ones git history shows were deleted into `<ext>\_repos-deleted-in-git\<repo>\`. It runs
  hourly and at session start/stop, and the guard runs it on the touched repository before any delete,
  `git clean`, `stash -u`, `reset --hard`, `checkout -- `/`restore` or worktree removal.
- Layout he chose: `<type>\<YYYY-MM-DD>\<file>` (hard links, each content once); the by-source copies live
  in `_by-source\`, browser icons in `_browser-icons\`. `archive-flatten.mjs` rebuilds the day folders.

## Where a rule survives, and where it dies

Auto-memory is **repo-derived**: one memory directory per repository, shared by all its worktrees —
but *not* shared across different repositories, and a session started with no project folder gets its
own throwaway directory. So a rule stated in a scratch session, or in a different project, is
stranded there. A rule that must outlive the session belongs in **this file** (if it is true
everywhere) or in **that project's tracked AGENTS.md / CLAUDE.md** (if it is not).
